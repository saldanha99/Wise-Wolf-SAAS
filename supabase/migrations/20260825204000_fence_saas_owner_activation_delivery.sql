-- Keep the paid SaaS owner activation recoverable without ever blindly
-- repeating an external email submission. The database owns the durable
-- CLAIMED -> SUBMITTING -> terminal state machine; the Edge Function owns the
-- provider call between the last two transitions.

create table if not exists public.saas_owner_activation_attempts (
  checkout_id uuid primary key
    references public.saas_checkout_intents(id) on delete cascade,
  tenant_id text not null
    references public.tenants(id) on delete cascade,
  owner_email text not null,
  owner_user_id uuid references auth.users(id) on delete set null,
  -- Immutable forensic identity. The FK-backed current owner may be cleared
  -- by an authorized auth deletion and later rebound to a replacement user.
  initial_owner_user_id uuid,
  -- The service-controlled auth marker may point to an earlier checkout that
  -- created this still-dormant identity. It is recorded, never rewritten, so
  -- retries can prove the same identity without an external metadata race.
  owner_identity_marker_checkout_id uuid,
  status text not null default 'CLAIMED'
    check (status in (
      'CLAIMED', 'SUBMITTING', 'SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED'
    )),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  submit_attempt_count integer not null default 0
    check (submit_attempt_count between 0 and 5),
  provider_message_id text,
  -- The exact Resend JSON body is staged before SUBMITTING so recovery never
  -- generates (and invalidates) a second Supabase recovery token. It never
  -- contains the Resend API key and is cleared at every terminal outcome.
  provider_payload text,
  provider_payload_sha256 text,
  provider_payload_staged_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint saas_owner_activation_email_canonical check (
    owner_email = lower(pg_catalog.btrim(owner_email))
    and length(owner_email) between 3 and 320
  ),
  constraint saas_owner_activation_provider_id_length check (
    provider_message_id is null or length(provider_message_id) between 1 and 240
  ),
  constraint saas_owner_activation_payload_pair check (
    (provider_payload is null) = (provider_payload_sha256 is null)
    and (provider_payload is null) = (provider_payload_staged_at is null)
  ),
  constraint saas_owner_activation_payload_length check (
    provider_payload is null or length(provider_payload) between 2 and 50000
  ),
  constraint saas_owner_activation_payload_hash check (
    provider_payload_sha256 is null
    or provider_payload_sha256 ~ '^[a-f0-9]{64}$'
  )
);

alter table public.saas_owner_activation_attempts
  add column if not exists provider_payload text;
alter table public.saas_owner_activation_attempts
  add column if not exists provider_payload_sha256 text;
alter table public.saas_owner_activation_attempts
  add column if not exists provider_payload_staged_at timestamptz;
alter table public.saas_owner_activation_attempts
  add column if not exists initial_owner_user_id uuid;
alter table public.saas_owner_activation_attempts
  add column if not exists owner_identity_marker_checkout_id uuid;

alter table public.saas_owner_activation_attempts
  drop constraint if exists saas_owner_activation_attempts_owner_user_id_fkey;
alter table public.saas_owner_activation_attempts
  add constraint saas_owner_activation_attempts_owner_user_id_fkey
  foreign key (owner_user_id) references auth.users(id) on delete set null;

update public.saas_owner_activation_attempts
   set provider_payload_staged_at = coalesce(
     provider_payload_staged_at,
     submitted_at,
     updated_at,
     created_at
   )
 where provider_payload is not null
   and provider_payload_staged_at is null;

update public.saas_owner_activation_attempts
   set initial_owner_user_id = owner_user_id
 where initial_owner_user_id is null
   and owner_user_id is not null;

update public.saas_owner_activation_attempts
   set owner_identity_marker_checkout_id = checkout_id
 where owner_identity_marker_checkout_id is null
   and owner_user_id is not null
   and (
     provider_payload is not null
     or submit_attempt_count > 0
     or status in ('SENT', 'FAILED')
   );

alter table public.saas_owner_activation_attempts
  drop constraint if exists saas_owner_activation_payload_pair;
alter table public.saas_owner_activation_attempts
  add constraint saas_owner_activation_payload_pair check (
    (provider_payload is null) = (provider_payload_sha256 is null)
    and (provider_payload is null) = (provider_payload_staged_at is null)
  );
alter table public.saas_owner_activation_attempts
  drop constraint if exists saas_owner_activation_payload_length;
alter table public.saas_owner_activation_attempts
  add constraint saas_owner_activation_payload_length check (
    provider_payload is null or length(provider_payload) between 2 and 50000
  );
alter table public.saas_owner_activation_attempts
  drop constraint if exists saas_owner_activation_payload_hash;
alter table public.saas_owner_activation_attempts
  add constraint saas_owner_activation_payload_hash check (
    provider_payload_sha256 is null
    or provider_payload_sha256 ~ '^[a-f0-9]{64}$'
  );

-- A retry is only allowed while Resend still retains the checkout-scoped
-- idempotency key. Each retry remains the same logical delivery; the bounded
-- counter prevents an unhealthy provider from becoming an infinite loop.
alter table public.saas_owner_activation_attempts
  drop constraint if exists
    saas_owner_activation_attempts_submit_attempt_count_check;
alter table public.saas_owner_activation_attempts
  add constraint saas_owner_activation_attempts_submit_attempt_count_check
  check (submit_attempt_count between 0 and 5);

drop index if exists public.saas_owner_activation_attention_idx;
create index saas_owner_activation_attention_idx
  on public.saas_owner_activation_attempts (status, updated_at)
  where status in ('CLAIMED', 'SUBMITTING', 'FAILED', 'UNKNOWN', 'SUPPRESSED');

alter table public.saas_owner_activation_attempts owner to postgres;
alter table public.saas_owner_activation_attempts enable row level security;
alter table public.saas_owner_activation_attempts force row level security;
revoke all on table public.saas_owner_activation_attempts
  from public, anon, authenticated, service_role;
grant select on table public.saas_owner_activation_attempts to service_role;

-- Existing provisioned checkouts predate this outbox. Mark them terminal so a
-- later renewal/replay cannot emit an unexpected historical activation. Once
-- this migration is active, an absent row means the current provisioning flow
-- crashed before it could establish its durable claim and is safe to resume.
insert into public.saas_owner_activation_attempts (
  checkout_id,
  tenant_id,
  owner_email,
  status,
  claim_token,
  lease_expires_at,
  completed_at,
  last_error
)
select
  checkout.id,
  checkout.tenant_id,
  lower(pg_catalog.btrim(checkout.owner_email)),
  'SUPPRESSED',
  gen_random_uuid(),
  pg_catalog.now(),
  pg_catalog.now(),
  'legacy_provisioned_before_activation_outbox'
from public.saas_checkout_intents as checkout
where checkout.status = 'PROVISIONED'
  and checkout.tenant_id is not null
  and length(lower(pg_catalog.btrim(checkout.owner_email))) between 3 and 320
on conflict (checkout_id) do nothing;

create or replace function public.claim_saas_owner_activation(
  p_checkout_id uuid,
  p_tenant_id text,
  p_owner_email text,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  checkout_row public.saas_checkout_intents%rowtype;
  attempt_row public.saas_owner_activation_attempts%rowtype;
  other_attempt public.saas_owner_activation_attempts%rowtype;
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  normalized_email text := lower(nullif(pg_catalog.btrim(coalesce(p_owner_email, '')), ''));
  calculated_payload_hash text;
  safe_lease integer := greatest(
    60,
    least(coalesce(p_lease_seconds, 300), 600)
  );
begin
  if p_checkout_id is null or normalized_tenant is null
     or normalized_email is null or length(normalized_email) > 320
     or p_claim_token is null
  then
    raise exception using
      errcode = '22023', message = 'invalid_saas_owner_activation_claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'saas-owner-activation-email:' || normalized_email,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'saas-owner-activation:' || p_checkout_id::text,
      0
    )
  );

  select checkout.* into checkout_row
    from public.saas_checkout_intents as checkout
   where checkout.id = p_checkout_id
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'saas_checkout_not_found';
  end if;
  if checkout_row.tenant_id is distinct from normalized_tenant
     or lower(pg_catalog.btrim(checkout_row.owner_email)) is distinct from normalized_email
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'saas_owner_activation_binding_mismatch'
    );
  end if;
  if checkout_row.status not in (
    'PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED'
  ) then
    select attempt.* into attempt_row
      from public.saas_owner_activation_attempts as attempt
     where attempt.checkout_id = p_checkout_id
     for update;
    if not found then
      insert into public.saas_owner_activation_attempts (
        checkout_id,
        tenant_id,
        owner_email,
        status,
        claim_token,
        lease_expires_at,
        completed_at,
        last_error
      ) values (
        p_checkout_id,
        normalized_tenant,
        normalized_email,
        'SUPPRESSED',
        p_claim_token,
        pg_catalog.now(),
        pg_catalog.now(),
        'saas_checkout_not_eligible_for_activation'
      )
      returning * into attempt_row;
    elsif attempt_row.status = 'CLAIMED'
       and attempt_row.submit_attempt_count = 0
    then
      update public.saas_owner_activation_attempts
         set status = 'SUPPRESSED',
             provider_payload = null,
             provider_payload_sha256 = null,
             provider_payload_staged_at = null,
             lease_expires_at = pg_catalog.now(),
             completed_at = pg_catalog.now(),
             last_error = 'saas_checkout_not_eligible_for_activation',
             updated_at = pg_catalog.now()
       where checkout_id = p_checkout_id
       returning * into attempt_row;
    elsif attempt_row.status = 'CLAIMED' then
      -- A previous provider attempt is already ambiguous. Cancellation may
      -- stop a new retry before mark, but it must never erase that evidence.
      update public.saas_owner_activation_attempts
         set status = 'UNKNOWN',
             lease_expires_at = pg_catalog.now(),
             completed_at = null,
             last_error = 'checkout_ineligible_after_ambiguous_delivery',
             updated_at = pg_catalog.now()
       where checkout_id = p_checkout_id
       returning * into attempt_row;
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_FINAL',
      'status', attempt_row.status,
      'checkout_id', p_checkout_id,
      'reason', 'saas_checkout_not_eligible_for_activation'
    );
  end if;

  -- Recovery tokens belong to the auth user/email, not to a checkout. Only
  -- one checkout may own activation delivery for an email at a time; a later
  -- paid checkout reuses the existing account and never invalidates its link.
  for other_attempt in
    select attempt.*
      from public.saas_owner_activation_attempts as attempt
      join public.saas_checkout_intents as other_checkout
        on other_checkout.id = attempt.checkout_id
     where attempt.owner_email = normalized_email
       and attempt.checkout_id <> p_checkout_id
       and attempt.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN')
       and other_checkout.status in ('PROVISIONING', 'PROVISIONING_FAILED')
     order by attempt.created_at, attempt.checkout_id
     for update of attempt, other_checkout
  loop
    -- Never terminalize another checkout from this claim. Its own durable
    -- inbox must resume it and atomically finish its checkout. Mutating it
    -- here could strand that checkout in PROVISIONING forever.
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'status', other_attempt.status,
      'checkout_id', p_checkout_id,
      'owner_activation_checkout_id', other_attempt.checkout_id
    );
  end loop;

  insert into public.saas_owner_activation_attempts (
    checkout_id,
    tenant_id,
    owner_email,
    claim_token,
    lease_expires_at
  ) values (
    p_checkout_id,
    normalized_tenant,
    normalized_email,
    p_claim_token,
    pg_catalog.now() + pg_catalog.make_interval(secs => safe_lease)
  ) on conflict (checkout_id) do nothing;

  select attempt.* into attempt_row
    from public.saas_owner_activation_attempts as attempt
   where attempt.checkout_id = p_checkout_id
   for update;

  if attempt_row.tenant_id is distinct from normalized_tenant
     or attempt_row.owner_email is distinct from normalized_email
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'saas_owner_activation_attempt_mismatch'
    );
  end if;

  if attempt_row.status = 'SUPPRESSED'
     and attempt_row.submit_attempt_count = 0
     and attempt_row.provider_payload is null
     and attempt_row.last_error in (
       'saas_owner_identity_not_ready_before_activation',
       'saas_owner_access_not_ready_before_activation'
     )
  then
    perform 1
      from public.tenants as tenant
     where tenant.id = attempt_row.tenant_id
       and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) = 'active'
     for update;
    if found then
      update public.saas_owner_activation_attempts
         set status = 'CLAIMED',
             owner_user_id = null,
             claim_token = p_claim_token,
             lease_expires_at = pg_catalog.now()
               + pg_catalog.make_interval(secs => safe_lease),
             completed_at = null,
             last_error = null,
             updated_at = pg_catalog.now()
       where checkout_id = p_checkout_id
       returning * into attempt_row;
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'SUBMIT_ONCE',
        'status', 'CLAIMED',
        'checkout_id', attempt_row.checkout_id,
        'claim_token', attempt_row.claim_token
      );
    end if;
  end if;

  if attempt_row.status in ('SENT', 'FAILED', 'SUPPRESSED') then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_FINAL',
      'status', attempt_row.status,
      'checkout_id', attempt_row.checkout_id
    );
  end if;

  -- The recovery link belongs to the deleted auth identity. Once a provider
  -- boundary was crossed it must never be replayed against a replacement
  -- UUID; terminalize visibly, clear the unusable bearer, and let the access
  -- repair path bind a new confirmed identity without another automatic send.
  if attempt_row.submit_attempt_count > 0
     and attempt_row.owner_user_id is null
  then
    update public.saas_owner_activation_attempts
       set status = 'FAILED',
           owner_identity_marker_checkout_id = null,
           provider_payload = null,
           provider_payload_sha256 = null,
           provider_payload_staged_at = null,
           lease_expires_at = pg_catalog.now(),
           completed_at = pg_catalog.now(),
           last_error = 'activation_owner_identity_removed_after_submit',
           updated_at = pg_catalog.now()
     where checkout_id = p_checkout_id
     returning * into attempt_row;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_FINAL',
      'status', 'FAILED',
      'checkout_id', attempt_row.checkout_id,
      'reason', 'activation_owner_identity_removed_after_submit'
    );
  end if;

  -- generateLink mutates GoTrue before the exact provider payload can be
  -- staged. Never hand an expired, payload-less first-generation claim to a
  -- second worker: it could generate a newer token and let the stale worker
  -- invalidate it. Expire to a visible/manual failure instead; the public
  -- self-service recovery flow remains available.
  if attempt_row.status = 'CLAIMED'
     and attempt_row.submit_attempt_count = 0
     and attempt_row.provider_payload is null
     and attempt_row.claim_token is distinct from p_claim_token
     and attempt_row.lease_expires_at <= pg_catalog.now()
  then
    update public.saas_owner_activation_attempts
       set status = 'FAILED',
           lease_expires_at = pg_catalog.now(),
           completed_at = pg_catalog.now(),
           last_error = 'activation_generation_claim_expired',
           updated_at = pg_catalog.now()
     where checkout_id = p_checkout_id
     returning * into attempt_row;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_FINAL',
      'status', 'FAILED',
      'checkout_id', attempt_row.checkout_id,
      'reason', 'activation_generation_claim_expired'
    );
  end if;

  if attempt_row.provider_payload is not null then
    calculated_payload_hash := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(attempt_row.provider_payload, 'UTF8'),
        'sha256'
      ),
      'hex'
    );
  end if;
  if (attempt_row.submit_attempt_count > 0
        and attempt_row.provider_payload is null)
     or attempt_row.provider_payload_sha256 is distinct from
       calculated_payload_hash
  then
    if attempt_row.status = 'CLAIMED'
       and attempt_row.submit_attempt_count = 0
    then
      update public.saas_owner_activation_attempts
         set status = 'SUPPRESSED',
             provider_payload = null,
             provider_payload_sha256 = null,
             provider_payload_staged_at = null,
             lease_expires_at = pg_catalog.now(),
             completed_at = pg_catalog.now(),
             last_error = 'activation_staged_payload_invalid_before_submit',
             updated_at = pg_catalog.now()
       where checkout_id = p_checkout_id;
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'ALREADY_FINAL',
        'status', 'SUPPRESSED',
        'checkout_id', p_checkout_id,
        'reason', 'activation_staged_payload_invalid_before_submit'
      );
    end if;

    update public.saas_owner_activation_attempts
       set status = case
             when status = 'CLAIMED' then 'UNKNOWN'
             else status
           end,
           lease_expires_at = pg_catalog.now(),
           completed_at = null,
           last_error = 'activation_staged_payload_invalid_after_submit',
           updated_at = pg_catalog.now()
     where checkout_id = p_checkout_id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'status', case
        when attempt_row.status = 'CLAIMED' then 'UNKNOWN'
        else attempt_row.status
      end,
      'checkout_id', p_checkout_id,
      'reason', 'activation_staged_payload_invalid_after_submit'
    );
  end if;

  -- A profile deleted after staging clears the FK with ON DELETE SET NULL.
  -- Since submit_attempt_count=0 proves the provider boundary was never
  -- crossed, discard that unsent link and generate a new one for the eventual
  -- replacement identity.
  if attempt_row.status = 'CLAIMED'
     and attempt_row.submit_attempt_count = 0
     and attempt_row.provider_payload is not null
     and attempt_row.owner_user_id is null
  then
    update public.saas_owner_activation_attempts
       set provider_payload = null,
           provider_payload_sha256 = null,
           provider_payload_staged_at = null,
           owner_identity_marker_checkout_id = null,
           last_error = 'activation_staged_identity_removed_before_submit',
           updated_at = pg_catalog.now()
     where checkout_id = p_checkout_id
     returning * into attempt_row;
  end if;

  -- A staged recovery token has a shorter validity window than the provider
  -- idempotency record. Before SUBMITTING it is provably unsent, so an expired
  -- staged payload can be cleared and regenerated safely.
  if attempt_row.status = 'CLAIMED'
     and attempt_row.submit_attempt_count = 0
     and attempt_row.provider_payload is not null
     and attempt_row.provider_payload_staged_at
       <= pg_catalog.now() - interval '50 minutes'
  then
    update public.saas_owner_activation_attempts
       set owner_user_id = null,
           owner_identity_marker_checkout_id = null,
           provider_payload = null,
           provider_payload_sha256 = null,
           provider_payload_staged_at = null,
           last_error = 'activation_staged_payload_expired_before_submit',
           updated_at = pg_catalog.now()
     where checkout_id = p_checkout_id
     returning * into attempt_row;
  end if;

  if attempt_row.status = 'SUBMITTING'
     and attempt_row.lease_expires_at > pg_catalog.now()
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'status', attempt_row.status,
      'checkout_id', attempt_row.checkout_id
    );
  end if;

  if attempt_row.status in ('SUBMITTING', 'UNKNOWN') then
    if attempt_row.submitted_at is null
       or attempt_row.submitted_at
          <= pg_catalog.now() - interval '50 minutes'
       or attempt_row.submit_attempt_count >= 5
    then
      update public.saas_owner_activation_attempts
         set status = 'FAILED',
             provider_payload = null,
             provider_payload_sha256 = null,
             provider_payload_staged_at = null,
             lease_expires_at = pg_catalog.now(),
             completed_at = pg_catalog.now(),
             last_error = 'activation_retry_window_closed',
             updated_at = pg_catalog.now()
       where checkout_id = p_checkout_id
       returning * into attempt_row;
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'ALREADY_FINAL',
        'status', 'FAILED',
        'checkout_id', attempt_row.checkout_id,
        'reason', 'activation_idempotency_window_closed'
      );
    end if;

    update public.saas_owner_activation_attempts
       set status = 'CLAIMED',
           claim_token = p_claim_token,
           lease_expires_at = pg_catalog.now()
             + pg_catalog.make_interval(secs => safe_lease),
           completed_at = null,
           updated_at = pg_catalog.now()
     where checkout_id = p_checkout_id
     returning * into attempt_row;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'RESUME_IDEMPOTENT',
      'status', attempt_row.status,
      'checkout_id', attempt_row.checkout_id,
      'claim_token', attempt_row.claim_token,
      'provider_payload', attempt_row.provider_payload
    );
  end if;

  if attempt_row.claim_token is distinct from p_claim_token
     and attempt_row.lease_expires_at > pg_catalog.now()
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'status', attempt_row.status,
      'checkout_id', attempt_row.checkout_id
    );
  end if;

  update public.saas_owner_activation_attempts
     set claim_token = p_claim_token,
         lease_expires_at = pg_catalog.now()
           + pg_catalog.make_interval(secs => safe_lease),
         last_error = null,
         updated_at = pg_catalog.now()
   where checkout_id = p_checkout_id
   returning * into attempt_row;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', case
      when attempt_row.submit_attempt_count = 0
        and attempt_row.provider_payload is null then 'SUBMIT_ONCE'
      else 'RESUME_IDEMPOTENT'
    end,
    'status', attempt_row.status,
    'checkout_id', attempt_row.checkout_id,
    'claim_token', attempt_row.claim_token,
    'provider_payload', attempt_row.provider_payload
  );
end;
$function$;

-- Called only while the public activation RPC already owns the checkout and
-- tenant locks. It installs owner access in that same transaction, preventing
-- a cancellation/refund from interleaving between the authorization check and
-- the membership write.
create or replace function private.ensure_saas_owner_access_locked(
  p_checkout_id uuid,
  p_tenant_id text,
  p_owner_email text,
  p_owner_user_id uuid,
  p_require_checkout_marker boolean
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  auth_email text;
  checkout_marker text;
  expected_checkout_marker text;
  profile_row public.profiles%rowtype;
  profile_inserted boolean := false;
  quarantine_owned boolean := false;
  canonical_tenant boolean := false;
  target_already_primary boolean := false;
  other_primary_exists boolean := false;
  make_primary boolean := false;
begin
  if p_checkout_id is null or p_tenant_id is null
     or p_owner_email is null or p_owner_user_id is null
  then
    return false;
  end if;

  perform 1
    from public.saas_checkout_intents as checkout
    join public.tenants as tenant on tenant.id = checkout.tenant_id
   where checkout.id = p_checkout_id
     and checkout.tenant_id = p_tenant_id
     and lower(pg_catalog.btrim(checkout.owner_email)) = p_owner_email
     and checkout.status in (
       'PAID', 'PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED'
     )
     and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) = 'active'
   for update of checkout, tenant;
  if not found then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'saas-owner-access-user:' || p_owner_user_id::text,
      0
    )
  );
  if p_require_checkout_marker then
    select coalesce(
      attempt.owner_identity_marker_checkout_id,
      attempt.checkout_id
    )::text
      into expected_checkout_marker
      from public.saas_owner_activation_attempts as attempt
     where attempt.checkout_id = p_checkout_id
       and (
         attempt.owner_user_id = p_owner_user_id
         or attempt.owner_user_id is null
       )
     for update;
    if not found then
      return false;
    end if;
  end if;
  select
    lower(pg_catalog.btrim(coalesce(auth_user.email, ''))),
    pg_catalog.btrim(coalesce(
      auth_user.raw_app_meta_data
        ->> 'saas_owner_activation_checkout_id',
      ''
    ))
    into auth_email, checkout_marker
    from auth.users as auth_user
   where auth_user.id = p_owner_user_id
     and auth_user.deleted_at is null
     and auth_user.email_confirmed_at is not null
     and (
       auth_user.banned_until is null
       or auth_user.banned_until <= pg_catalog.now()
     )
   for update;
  if not found
     or auth_email is distinct from p_owner_email
     or (
       p_require_checkout_marker
       and checkout_marker is distinct from expected_checkout_marker
     )
  then
    return false;
  end if;

  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_owner_user_id
   for update;
  if found and lower(pg_catalog.btrim(coalesce(
       profile_row.lifecycle_status,
       ''
     ))) <> 'active'
  then
    return false;
  end if;
  if not found then
    insert into public.profiles (
      id,
      full_name,
      email,
      role,
      tenant_id,
      status_financial,
      created_at
    ) values (
      p_owner_user_id,
      coalesce(nullif(auth_email, ''), 'Administrador da escola'),
      auth_email,
      'SCHOOL_ADMIN',
      p_tenant_id,
      'ACTIVE',
      pg_catalog.now()
    )
    returning * into profile_row;
    profile_inserted := true;
  end if;

  quarantine_owned := p_require_checkout_marker
    and checkout_marker = expected_checkout_marker
    and profile_row.tenant_id is null
    and profile_row.role = 'STUDENT'
    and profile_row.status_financial = 'PENDING';
  if quarantine_owned then
    update public.profiles
       set tenant_id = p_tenant_id,
           role = 'SCHOOL_ADMIN',
           status_financial = 'ACTIVE'
     where id = p_owner_user_id
       and tenant_id is null
       and role = 'STUDENT'
       and status_financial = 'PENDING'
     returning * into profile_row;
    if not found then
      return false;
    end if;
  elsif profile_row.tenant_id = p_tenant_id
        and profile_row.role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  then
    -- Becoming the checkout owner grants the role but never clears an
    -- existing student's/teacher's financial state.
    update public.profiles
       set role = 'SCHOOL_ADMIN'
     where id = p_owner_user_id
       and tenant_id = p_tenant_id
       and role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
     returning * into profile_row;
    if not found then
      return false;
    end if;
  end if;

  canonical_tenant := profile_inserted
    or quarantine_owned
    or profile_row.tenant_id = p_tenant_id;
  perform 1
    from public.tenant_memberships as membership
   where membership.user_id = p_owner_user_id
   order by membership.tenant_id
   for update;
  select coalesce(pg_catalog.bool_or(
      membership.tenant_id = p_tenant_id
      and membership.is_primary
      and membership.status = 'ACTIVE'
    ), false),
    coalesce(pg_catalog.bool_or(
      membership.tenant_id <> p_tenant_id
      and membership.is_primary
      and membership.status = 'ACTIVE'
    ), false)
    into target_already_primary, other_primary_exists
    from public.tenant_memberships as membership
   where membership.user_id = p_owner_user_id;
  make_primary := canonical_tenant
    and (target_already_primary or not other_primary_exists);

  insert into public.tenant_memberships (
    user_id,
    tenant_id,
    role,
    status,
    is_primary,
    updated_at
  ) values (
    p_owner_user_id,
    p_tenant_id,
    'SCHOOL_ADMIN',
    'ACTIVE',
    make_primary,
    pg_catalog.now()
  )
  on conflict (user_id, tenant_id) do update
    set role = excluded.role,
        status = excluded.status,
        is_primary = excluded.is_primary,
        updated_at = excluded.updated_at;

  return exists (
    select 1
      from public.tenant_memberships as membership
     where membership.user_id = p_owner_user_id
       and membership.tenant_id = p_tenant_id
       and membership.role = 'SCHOOL_ADMIN'
       and membership.status = 'ACTIVE'
  );
end;
$function$;

create or replace function private.saas_owner_identity_is_dormant_for_activation(
  p_current_checkout_id uuid,
  p_owner_user_id uuid,
  p_marker_checkout_id uuid,
  p_owner_email text
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select p_current_checkout_id is not null
    and p_owner_user_id is not null
    and p_marker_checkout_id is not null
    and p_marker_checkout_id <> p_current_checkout_id
    and p_owner_email is not null
    and exists (
      select 1
        from public.saas_owner_activation_attempts as origin_attempt
        join public.saas_checkout_intents as origin_checkout
          on origin_checkout.id = origin_attempt.checkout_id
       where origin_attempt.checkout_id = p_marker_checkout_id
         and origin_attempt.owner_email = p_owner_email
         and lower(pg_catalog.btrim(origin_checkout.owner_email)) = p_owner_email
         and origin_checkout.tenant_id = origin_attempt.tenant_id
         and origin_attempt.status in ('FAILED', 'SUPPRESSED')
         and origin_attempt.submit_attempt_count = 0
         and origin_attempt.provider_payload is null
         and origin_attempt.provider_payload_sha256 is null
         and origin_attempt.provider_payload_staged_at is null
         and origin_attempt.submitted_at is null
         and origin_attempt.provider_message_id is null
         and (
           origin_attempt.owner_user_id is null
           or origin_attempt.owner_user_id = p_owner_user_id
         )
         and (
           origin_attempt.initial_owner_user_id is null
           or origin_attempt.initial_owner_user_id = p_owner_user_id
         )
         and (
           origin_checkout.status not in (
             'PAID', 'PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED'
           )
           or not private.tenant_is_operational(origin_attempt.tenant_id)
         )
    )
    and not exists (
      select 1
        from public.saas_owner_activation_attempts as delivered_attempt
       where delivered_attempt.checkout_id <> p_current_checkout_id
         and (
           delivered_attempt.owner_user_id = p_owner_user_id
           or delivered_attempt.initial_owner_user_id = p_owner_user_id
         )
         and (
           delivered_attempt.submit_attempt_count > 0
           or delivered_attempt.status in ('SUBMITTING', 'SENT', 'UNKNOWN')
         )
    )
    and not exists (
      select 1
        from public.tenant_memberships as membership
       where membership.user_id = p_owner_user_id
         and membership.status = 'ACTIVE'
    )
    and not exists (
      select 1
        from public.profiles as profile
       where profile.id = p_owner_user_id
         and not (
           profile.tenant_id is null
           and profile.role = 'STUDENT'
           and profile.status_financial = 'PENDING'
           and lower(pg_catalog.btrim(coalesce(
             profile.lifecycle_status,
             ''
           ))) = 'active'
         )
    )
    and not exists (
      select 1 from public.hub_accounts as account
       where account.owner_user_id = p_owner_user_id
    )
    and not exists (
      select 1 from public.hub_memberships as membership
       where membership.user_id = p_owner_user_id
    )
    and not exists (
      select 1 from auth.sessions as session
       where session.user_id = p_owner_user_id
    )
    and not exists (
      select 1 from auth.mfa_factors as factor
       where factor.user_id = p_owner_user_id
    )
    and exists (
      select 1 from auth.users as auth_user
       where auth_user.id = p_owner_user_id
         and auth_user.deleted_at is null
         and auth_user.last_sign_in_at is null
    );
$function$;

create or replace function public.classify_saas_owner_activation_identity(
  p_checkout_id uuid,
  p_claim_token uuid,
  p_owner_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.saas_owner_activation_attempts%rowtype;
  checkout_row public.saas_checkout_intents%rowtype;
  auth_user_row auth.users%rowtype;
  normalized_email text;
  marker_text text;
  marker_checkout_id uuid;
  expected_marker_checkout_id uuid;
  tenant_ready boolean := false;
  established_account boolean := false;
begin
  if p_checkout_id is null or p_claim_token is null
     or p_owner_user_id is null
  then
    raise exception using
      errcode = '22023', message = 'invalid_saas_owner_identity_classification';
  end if;

  select checkout.* into checkout_row
    from public.saas_checkout_intents as checkout
   where checkout.id = p_checkout_id
   for update;
  if checkout_row.id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'saas_owner_activation_checkout_missing'
    );
  end if;
  perform 1 from public.tenants as tenant
   where tenant.id = checkout_row.tenant_id
     and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) = 'active'
   for update;
  tenant_ready := found;
  if checkout_row.status not in (
    'PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED'
  )
     or not tenant_ready
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'NOT_REQUIRED',
      'reason', 'saas_checkout_not_operational_for_identity_classification'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'saas-owner-activation:' || p_checkout_id::text,
      0
    )
  );

  select attempt.* into attempt_row
    from public.saas_owner_activation_attempts as attempt
   where attempt.checkout_id = p_checkout_id
   for update;
  if not found
     or attempt_row.status <> 'CLAIMED'
     or attempt_row.claim_token is distinct from p_claim_token
     or attempt_row.lease_expires_at <= pg_catalog.now()
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'saas_owner_identity_classification_claim_lost'
    );
  end if;
  if checkout_row.tenant_id is distinct from attempt_row.tenant_id
     or lower(pg_catalog.btrim(checkout_row.owner_email))
       is distinct from attempt_row.owner_email
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'NOT_REQUIRED',
      'reason', 'saas_checkout_not_operational_for_identity_classification'
    );
  end if;

  normalized_email := lower(pg_catalog.btrim(attempt_row.owner_email));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'saas-owner-activation-email:' || normalized_email,
      0
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'saas-owner-access-user:' || p_owner_user_id::text,
      0
    )
  );
  select auth_user.* into auth_user_row
    from auth.users as auth_user
   where auth_user.id = p_owner_user_id
     and auth_user.deleted_at is null
     and auth_user.email_confirmed_at is not null
     and (
       auth_user.banned_until is null
       or auth_user.banned_until <= pg_catalog.now()
     )
   for update;
  if not found
     or lower(pg_catalog.btrim(coalesce(auth_user_row.email, '')))
       is distinct from attempt_row.owner_email
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'saas_owner_identity_not_operational'
    );
  end if;

  marker_text := pg_catalog.btrim(coalesce(
    auth_user_row.raw_app_meta_data
      ->> 'saas_owner_activation_checkout_id',
    ''
  ));
  if marker_text <> '' then
    begin
      marker_checkout_id := marker_text::uuid;
    exception when invalid_text_representation then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'saas_owner_identity_marker_invalid'
      );
    end;
  end if;

  expected_marker_checkout_id := coalesce(
    attempt_row.owner_identity_marker_checkout_id,
    p_checkout_id
  );
  if attempt_row.owner_user_id = p_owner_user_id
     and attempt_row.provider_payload is not null
     and marker_checkout_id = expected_marker_checkout_id
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'CHECKOUT_IDENTITY',
      'marker_checkout_id', marker_checkout_id
    );
  end if;

  established_account := auth_user_row.last_sign_in_at is not null
    or auth_user_row.recovery_sent_at is not null
    or exists (
      select 1 from public.tenant_memberships as membership
       where membership.user_id = p_owner_user_id
         and membership.status = 'ACTIVE'
    )
    or exists (
      select 1 from public.profiles as profile
       where profile.id = p_owner_user_id
         and not (
           profile.tenant_id is null
           and profile.role = 'STUDENT'
           and profile.status_financial = 'PENDING'
           and lower(pg_catalog.btrim(coalesce(
             profile.lifecycle_status,
             ''
           ))) = 'active'
         )
    )
    or exists (
      select 1 from public.hub_accounts as account
       where account.owner_user_id = p_owner_user_id
    )
    or exists (
      select 1 from public.hub_memberships as membership
       where membership.user_id = p_owner_user_id
    )
    or exists (
      select 1 from auth.sessions as session
       where session.user_id = p_owner_user_id
    )
    or exists (
      select 1 from auth.mfa_factors as factor
       where factor.user_id = p_owner_user_id
    );
  if established_account or marker_checkout_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'EXISTING_ACCOUNT'
    );
  end if;
  if marker_checkout_id = p_checkout_id then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'CHECKOUT_IDENTITY',
      'marker_checkout_id', marker_checkout_id
    );
  end if;
  if private.saas_owner_identity_is_dormant_for_activation(
       p_checkout_id,
       p_owner_user_id,
       marker_checkout_id,
       attempt_row.owner_email
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'DORMANT_CHECKOUT_IDENTITY',
      'marker_checkout_id', marker_checkout_id
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', false,
    'action', 'REVIEW_REQUIRED',
    'reason', 'saas_owner_identity_requires_manual_review'
  );
end;
$function$;

create or replace function public.stage_saas_owner_activation_payload(
  p_checkout_id uuid,
  p_claim_token uuid,
  p_owner_user_id uuid,
  p_provider_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.saas_owner_activation_attempts%rowtype;
  checkout_row public.saas_checkout_intents%rowtype;
  payload_json jsonb;
  payload_hash text;
  recipient text;
  identity_marker_text text;
  identity_marker_checkout_id uuid;
  tenant_ready boolean := false;
  owner_identity_ready boolean := false;
begin
  if p_checkout_id is null or p_claim_token is null
     or p_owner_user_id is null or p_provider_payload is null
     or length(p_provider_payload) not between 2 and 50000
  then
    raise exception using
      errcode = '22023', message = 'invalid_saas_owner_activation_payload';
  end if;
  begin
    payload_json := p_provider_payload::jsonb;
  exception when others then
    raise exception using
      errcode = '22023', message = 'invalid_saas_owner_activation_payload';
  end;
  if pg_catalog.jsonb_typeof(payload_json) <> 'object'
     or pg_catalog.jsonb_typeof(payload_json -> 'to') <> 'array'
     or pg_catalog.jsonb_array_length(payload_json -> 'to') <> 1
  then
    raise exception using
      errcode = '22023', message = 'invalid_saas_owner_activation_payload';
  end if;
  recipient := lower(nullif(pg_catalog.btrim(payload_json #>> '{to,0}'), ''));
  if recipient is null
     or length(coalesce(payload_json ->> 'html', '')) not between 1 and 40000
     or payload_json ->> 'subject' <> 'Ative seu acesso à Wise Wolf'
  then
    raise exception using
      errcode = '22023', message = 'invalid_saas_owner_activation_payload';
  end if;

  payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(p_provider_payload, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'saas-owner-activation:' || p_checkout_id::text,
      0
    )
  );

  select attempt.* into attempt_row
    from public.saas_owner_activation_attempts as attempt
   where attempt.checkout_id = p_checkout_id
   for update;
  if not found
     or attempt_row.status <> 'CLAIMED'
     or attempt_row.claim_token is distinct from p_claim_token
     or attempt_row.lease_expires_at <= pg_catalog.now()
     or attempt_row.submit_attempt_count <> 0
     or attempt_row.owner_email is distinct from recipient
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'activation_payload_claim_lost'
    );
  end if;

  select checkout.* into checkout_row
    from public.saas_checkout_intents as checkout
   where checkout.id = p_checkout_id
   for update;
  if found then
    perform 1
      from public.tenants as tenant
     where tenant.id = checkout_row.tenant_id
       and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) = 'active'
     for update;
    tenant_ready := found;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'saas-owner-access-user:' || p_owner_user_id::text,
        0
      )
    );
    select pg_catalog.btrim(coalesce(
      auth_user.raw_app_meta_data
        ->> 'saas_owner_activation_checkout_id',
      ''
    ))
      into identity_marker_text
      from auth.users as auth_user
     where auth_user.id = p_owner_user_id
       and auth_user.deleted_at is null
       and auth_user.email_confirmed_at is not null
       and (
         auth_user.banned_until is null
         or auth_user.banned_until <= pg_catalog.now()
       )
       and lower(pg_catalog.btrim(coalesce(auth_user.email, '')))
         = attempt_row.owner_email
     for update of auth_user;
    owner_identity_ready := found;
    if owner_identity_ready then
      begin
        identity_marker_checkout_id := identity_marker_text::uuid;
      exception when invalid_text_representation then
        owner_identity_ready := false;
      end;
    end if;
    owner_identity_ready := owner_identity_ready and (
      identity_marker_checkout_id = p_checkout_id
      or private.saas_owner_identity_is_dormant_for_activation(
        p_checkout_id,
        p_owner_user_id,
        identity_marker_checkout_id,
        attempt_row.owner_email
      )
    );
  end if;

  if checkout_row.id is null
     or checkout_row.status not in (
       'PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED'
     )
     or checkout_row.tenant_id is distinct from attempt_row.tenant_id
     or lower(pg_catalog.btrim(checkout_row.owner_email))
       is distinct from attempt_row.owner_email
     or not tenant_ready
  then
    update public.saas_owner_activation_attempts
       set status = 'SUPPRESSED',
           owner_user_id = p_owner_user_id,
           initial_owner_user_id = coalesce(
             initial_owner_user_id,
             p_owner_user_id
           ),
           owner_identity_marker_checkout_id = coalesce(
             owner_identity_marker_checkout_id,
             identity_marker_checkout_id
           ),
           provider_payload = null,
           provider_payload_sha256 = null,
           provider_payload_staged_at = null,
           lease_expires_at = pg_catalog.now(),
           completed_at = pg_catalog.now(),
           last_error = 'saas_owner_identity_not_ready_before_activation',
           updated_at = pg_catalog.now()
     where checkout_id = p_checkout_id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'SUPPRESSED',
      'reason', 'saas_owner_identity_not_ready_before_activation'
    );
  end if;

  if not owner_identity_ready then
    update public.saas_owner_activation_attempts
       set lease_expires_at = pg_catalog.now(),
           last_error = 'saas_owner_identity_not_ready_before_activation',
           updated_at = pg_catalog.now()
     where checkout_id = p_checkout_id
       and claim_token = p_claim_token
       and status = 'CLAIMED';
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'saas_owner_identity_not_ready_before_activation'
    );
  end if;

  if attempt_row.provider_payload is not null then
    return pg_catalog.jsonb_build_object(
      'ok', attempt_row.provider_payload_sha256 = payload_hash
        and attempt_row.owner_user_id = p_owner_user_id
        and attempt_row.owner_identity_marker_checkout_id =
          identity_marker_checkout_id,
      'action', case
        when attempt_row.provider_payload_sha256 = payload_hash
          and attempt_row.owner_user_id = p_owner_user_id
          and attempt_row.owner_identity_marker_checkout_id =
            identity_marker_checkout_id
          then 'STAGED'
        else 'REVIEW_REQUIRED'
      end,
      'reason', case
        when attempt_row.provider_payload_sha256 = payload_hash
          and attempt_row.owner_user_id = p_owner_user_id
          and attempt_row.owner_identity_marker_checkout_id =
            identity_marker_checkout_id then null
        else 'activation_payload_is_immutable'
      end,
      'payload_sha256', attempt_row.provider_payload_sha256
    );
  end if;

  update public.saas_owner_activation_attempts
     set owner_user_id = p_owner_user_id,
         initial_owner_user_id = coalesce(
           initial_owner_user_id,
           p_owner_user_id
         ),
         owner_identity_marker_checkout_id = identity_marker_checkout_id,
         provider_payload = p_provider_payload,
         provider_payload_sha256 = payload_hash,
         provider_payload_staged_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where checkout_id = p_checkout_id
     and claim_token = p_claim_token
     and status = 'CLAIMED'
     and lease_expires_at > pg_catalog.now()
     and submit_attempt_count = 0
     and owner_user_id is null
     and provider_payload is null;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'activation_claim_changed_before_payload_stage'
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'STAGED',
    'payload_sha256', payload_hash
  );
end;
$function$;

create or replace function public.suppress_saas_owner_activation(
  p_checkout_id uuid,
  p_claim_token uuid,
  p_owner_user_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_reason text := lower(
    pg_catalog.btrim(coalesce(p_reason, ''))
  );
  attempt_row public.saas_owner_activation_attempts%rowtype;
  checkout_row public.saas_checkout_intents%rowtype;
  tenant_ready boolean := false;
  owner_access_ready boolean := false;
  changed_checkout_id uuid;
begin
  if p_checkout_id is null or p_claim_token is null
     or p_owner_user_id is null
     or normalized_reason not in (
       'existing_owner_account', 'owner_activation_not_required'
     )
  then
    raise exception using
      errcode = '22023', message = 'invalid_saas_owner_activation_suppression';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'saas-owner-activation:' || p_checkout_id::text,
      0
    )
  );

  select attempt.* into attempt_row
    from public.saas_owner_activation_attempts as attempt
   where attempt.checkout_id = p_checkout_id
   for update;
  if not found
     or attempt_row.claim_token is distinct from p_claim_token
     or attempt_row.status <> 'CLAIMED'
     or attempt_row.submit_attempt_count <> 0
     or attempt_row.lease_expires_at <= pg_catalog.now()
     or not (
       (
         attempt_row.provider_payload is null
         and attempt_row.owner_user_id is null
       )
       or (
         attempt_row.provider_payload is not null
         and attempt_row.owner_user_id = p_owner_user_id
       )
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'activation_claim_lost'
    );
  end if;

  select checkout.* into checkout_row
    from public.saas_checkout_intents as checkout
   where checkout.id = p_checkout_id
   for update;
  if found then
    perform 1
      from public.tenants as tenant
     where tenant.id = checkout_row.tenant_id
       and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) = 'active'
     for update;
    tenant_ready := found;
  end if;

  if checkout_row.id is null
     or checkout_row.status not in (
       'PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED'
     )
     or checkout_row.tenant_id is distinct from attempt_row.tenant_id
     or lower(pg_catalog.btrim(checkout_row.owner_email))
       is distinct from attempt_row.owner_email
     or not tenant_ready
  then
    update public.saas_owner_activation_attempts
       set status = 'SUPPRESSED',
           owner_user_id = p_owner_user_id,
           initial_owner_user_id = coalesce(
             initial_owner_user_id,
             p_owner_user_id
           ),
           provider_payload = null,
           provider_payload_sha256 = null,
           provider_payload_staged_at = null,
           lease_expires_at = pg_catalog.now(),
           completed_at = pg_catalog.now(),
           last_error = 'saas_owner_access_not_ready_before_activation',
           updated_at = pg_catalog.now()
     where checkout_id = p_checkout_id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'SUPPRESSED',
      'status', 'SUPPRESSED',
      'reason', 'saas_owner_access_not_ready_before_activation'
    );
  end if;

  owner_access_ready := private.ensure_saas_owner_access_locked(
    p_checkout_id,
    attempt_row.tenant_id,
    attempt_row.owner_email,
    p_owner_user_id,
    false
  );
  if not owner_access_ready then
    update public.saas_owner_activation_attempts
       set lease_expires_at = pg_catalog.now(),
           last_error = 'saas_owner_identity_not_ready_before_suppression',
           updated_at = pg_catalog.now()
     where checkout_id = p_checkout_id
       and claim_token = p_claim_token
       and status = 'CLAIMED';
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'saas_owner_identity_not_ready_before_suppression'
    );
  end if;

  update public.saas_checkout_intents
     set status = 'PROVISIONED',
         provisioned_at = coalesce(provisioned_at, pg_catalog.now()),
         last_error = null,
         updated_at = pg_catalog.now()
   where id = p_checkout_id
     and status in ('PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED')
     and tenant_id = attempt_row.tenant_id
     and lower(pg_catalog.btrim(owner_email)) = attempt_row.owner_email;
  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'saas_checkout_changed_before_activation_suppression';
  end if;

  update public.saas_owner_activation_attempts
     set status = 'SUPPRESSED',
         owner_user_id = p_owner_user_id,
         initial_owner_user_id = coalesce(
           initial_owner_user_id,
           p_owner_user_id
         ),
         provider_payload = null,
         provider_payload_sha256 = null,
         provider_payload_staged_at = null,
         lease_expires_at = pg_catalog.now(),
         completed_at = pg_catalog.now(),
         last_error = normalized_reason,
         updated_at = pg_catalog.now()
   where checkout_id = p_checkout_id
     and claim_token = p_claim_token
     and status = 'CLAIMED'
     and submit_attempt_count = 0
     and lease_expires_at > pg_catalog.now()
     and (
       (provider_payload is null and owner_user_id = p_owner_user_id)
       or (
         provider_payload is null and owner_user_id is null
       )
       or (
         provider_payload is not null and owner_user_id = p_owner_user_id
       )
     )
   returning checkout_id into changed_checkout_id;
  if changed_checkout_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'saas_activation_claim_changed_during_suppression';
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'SUPPRESSED',
    'status', 'SUPPRESSED',
    'reason', normalized_reason
  );
end;
$function$;

create or replace function public.repair_saas_owner_access(
  p_checkout_id uuid,
  p_owner_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.saas_owner_activation_attempts%rowtype;
  checkout_row public.saas_checkout_intents%rowtype;
  attempt_found boolean := false;
  tenant_ready boolean := false;
  access_ready boolean := false;
  require_marker boolean := false;
  repair_owner_user_id uuid;
begin
  if p_checkout_id is null then
    raise exception using
      errcode = '22023', message = 'invalid_saas_owner_access_repair';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'saas-owner-activation:' || p_checkout_id::text,
      0
    )
  );

  select checkout.* into checkout_row
    from public.saas_checkout_intents as checkout
   where checkout.id = p_checkout_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'NOT_REQUIRED',
      'reason', 'checkout_missing_for_owner_repair'
    );
  end if;

  select attempt.* into attempt_row
    from public.saas_owner_activation_attempts as attempt
   where attempt.checkout_id = p_checkout_id
   for update;
  attempt_found := found;

  if checkout_row.status not in (
    'PAID', 'PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'NOT_REQUIRED',
      'reason', 'checkout_not_operational_for_owner_repair'
    );
  end if;

  if not attempt_found
     or attempt_row.status not in ('SENT', 'FAILED', 'SUPPRESSED')
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'terminal_activation_attempt_required'
    );
  end if;

  if attempt_row.status <> 'FAILED'
     and checkout_row.status <> 'PROVISIONED'
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'NOT_REQUIRED',
      'reason', 'checkout_not_operational_for_owner_repair'
    );
  end if;

  if checkout_row.tenant_id is distinct from attempt_row.tenant_id
     or lower(pg_catalog.btrim(checkout_row.owner_email))
       is distinct from attempt_row.owner_email
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'NOT_REQUIRED',
      'reason', 'checkout_not_operational_for_owner_repair'
    );
  end if;

  perform 1
    from public.tenants as tenant
   where tenant.id = checkout_row.tenant_id
     and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) = 'active'
   for update;
  tenant_ready := found;
  if not tenant_ready then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'NOT_REQUIRED',
      'reason', 'tenant_not_operational_for_owner_repair'
    );
  end if;

  repair_owner_user_id := p_owner_user_id;
  if repair_owner_user_id is null then
    if attempt_row.owner_user_id is null then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'owner_identity_required_for_access_repair'
      );
    end if;
    -- A terminal attempt already bound to a live identity must be repaired
    -- with that exact identity. A null preflight may never manufacture a
    -- second auth user merely because an email lookup drifted.
    repair_owner_user_id := attempt_row.owner_user_id;
  elsif attempt_row.owner_user_id is not null
        and attempt_row.owner_user_id <> repair_owner_user_id
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'owner_identity_conflict_for_access_repair'
    );
  end if;
  require_marker := attempt_row.status in ('SENT', 'FAILED');
  access_ready := private.ensure_saas_owner_access_locked(
    p_checkout_id,
    attempt_row.tenant_id,
    attempt_row.owner_email,
    repair_owner_user_id,
    require_marker
  );
  if not access_ready then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'owner_access_repair_identity_invalid'
    );
  end if;

  if attempt_row.status = 'FAILED' then
    update public.saas_checkout_intents
       set status = 'PROVISIONED',
           provisioned_at = coalesce(provisioned_at, pg_catalog.now()),
           last_error = coalesce(last_error, 'activation_email_failed'),
           updated_at = pg_catalog.now()
     where id = p_checkout_id
       and status in (
         'PAID', 'PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED'
       )
       and tenant_id = attempt_row.tenant_id
       and lower(pg_catalog.btrim(owner_email)) = attempt_row.owner_email;
    if not found then
      raise exception using
        errcode = 'P0001', message = 'saas_owner_access_repair_checkout_changed';
    end if;
  end if;

  update public.saas_owner_activation_attempts
     set owner_user_id = coalesce(owner_user_id, repair_owner_user_id),
         initial_owner_user_id = coalesce(
           initial_owner_user_id,
           repair_owner_user_id
         ),
         updated_at = pg_catalog.now()
   where checkout_id = p_checkout_id
     and status in ('SENT', 'FAILED', 'SUPPRESSED')
     and (
       owner_user_id is null
       or owner_user_id = repair_owner_user_id
     );
  if not found then
    raise exception using
      errcode = 'P0001', message = 'saas_owner_access_repair_binding_changed';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'REPAIRED',
    'status', attempt_row.status
  );
end;
$function$;

create or replace function public.mark_saas_owner_activation_submitting(
  p_checkout_id uuid,
  p_claim_token uuid,
  p_owner_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.saas_owner_activation_attempts%rowtype;
  checkout_row public.saas_checkout_intents%rowtype;
  checkout_found boolean := false;
  tenant_ready boolean := false;
  owner_access_ready boolean := false;
  calculated_payload_hash text;
begin
  if p_checkout_id is null or p_claim_token is null or p_owner_user_id is null then
    raise exception using
      errcode = '22023', message = 'invalid_saas_owner_activation_submit';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'saas-owner-activation:' || p_checkout_id::text,
      0
    )
  );

  select attempt.* into attempt_row
    from public.saas_owner_activation_attempts as attempt
   where attempt.checkout_id = p_checkout_id
   for update;
  if attempt_row.provider_payload is not null then
    calculated_payload_hash := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(attempt_row.provider_payload, 'UTF8'),
        'sha256'
      ),
      'hex'
    );
  end if;
  if not found
     or attempt_row.status <> 'CLAIMED'
     or attempt_row.claim_token is distinct from p_claim_token
     or attempt_row.lease_expires_at <= pg_catalog.now()
     or attempt_row.submit_attempt_count not between 0 and 4
     or attempt_row.provider_payload is null
     or attempt_row.owner_user_id is distinct from p_owner_user_id
     or attempt_row.provider_payload_sha256 is distinct from
       calculated_payload_hash
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'activation_claim_lost'
    );
  end if;

  select checkout.* into checkout_row
    from public.saas_checkout_intents as checkout
   where checkout.id = p_checkout_id
   for update;
  checkout_found := found;

  if checkout_found then
    perform 1
      from public.tenants as tenant
     where tenant.id = checkout_row.tenant_id
       and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) = 'active'
     for update;
    tenant_ready := found;

  end if;

  if not checkout_found
     or checkout_row.status not in (
       'PAID', 'PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED'
     )
     or checkout_row.tenant_id is distinct from attempt_row.tenant_id
     or lower(pg_catalog.btrim(checkout_row.owner_email))
       is distinct from attempt_row.owner_email
     or not tenant_ready
  then
    if attempt_row.submit_attempt_count = 0 then
      update public.saas_owner_activation_attempts
         set status = 'SUPPRESSED',
             owner_user_id = p_owner_user_id,
             initial_owner_user_id = coalesce(
               initial_owner_user_id,
               p_owner_user_id
             ),
             provider_payload = null,
             provider_payload_sha256 = null,
             provider_payload_staged_at = null,
             lease_expires_at = pg_catalog.now(),
             completed_at = pg_catalog.now(),
             last_error = 'saas_owner_access_not_ready_before_activation',
             updated_at = pg_catalog.now()
       where checkout_id = p_checkout_id;
    else
      -- At least one provider boundary was crossed previously. Preserve the
      -- exact payload and ambiguous audit instead of claiming suppression.
      update public.saas_owner_activation_attempts
         set status = 'UNKNOWN',
             lease_expires_at = pg_catalog.now(),
             completed_at = null,
             last_error = 'saas_owner_access_not_ready_after_delivery',
             updated_at = pg_catalog.now()
       where checkout_id = p_checkout_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', case
        when attempt_row.submit_attempt_count = 0 then 'SUPPRESSED'
        else 'REVIEW_REQUIRED'
      end,
      'reason', 'saas_owner_access_not_ready_before_activation'
    );
  end if;

  owner_access_ready := private.ensure_saas_owner_access_locked(
    p_checkout_id,
    attempt_row.tenant_id,
    attempt_row.owner_email,
    p_owner_user_id,
    true
  );
  if not owner_access_ready then
    update public.saas_owner_activation_attempts
       set lease_expires_at = pg_catalog.now(),
           last_error = 'saas_owner_identity_changed_before_activation',
           updated_at = pg_catalog.now()
     where checkout_id = p_checkout_id
       and claim_token = p_claim_token
       and status = 'CLAIMED';
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'saas_owner_identity_changed_before_activation'
    );
  end if;

  -- The checkout completion and the irreversible email submit boundary share
  -- the same checkout/tenant locks. A concurrent refund/cancellation either
  -- linearizes before this block and is suppressed above, or after this
  -- authorization without ever being overwritten by application code.
  update public.saas_checkout_intents
     set status = 'PROVISIONED',
         provisioned_at = coalesce(provisioned_at, pg_catalog.now()),
         last_error = null,
         updated_at = pg_catalog.now()
   where id = p_checkout_id
     and status in ('PAID', 'PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED')
     and tenant_id = attempt_row.tenant_id
     and lower(pg_catalog.btrim(owner_email)) = attempt_row.owner_email;
  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'saas_checkout_changed_before_activation';
  end if;

  update public.saas_owner_activation_attempts
     set status = 'SUBMITTING',
         submit_attempt_count = submit_attempt_count + 1,
         submitted_at = coalesce(submitted_at, pg_catalog.now()),
         lease_expires_at = pg_catalog.now() + interval '10 minutes',
         updated_at = pg_catalog.now()
   where checkout_id = p_checkout_id
     and claim_token = p_claim_token
     and status = 'CLAIMED'
     and lease_expires_at > pg_catalog.now()
     and owner_user_id = p_owner_user_id
     and provider_payload is not null
     and provider_payload_sha256 = calculated_payload_hash;
  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'saas_activation_identity_or_payload_changed_before_submit';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', case
      when attempt_row.submit_attempt_count = 0 then 'SUBMIT_ONCE'
      else 'RESUME_IDEMPOTENT'
    end,
    'status', 'SUBMITTING'
  );
end;
$function$;

create or replace function public.finish_saas_owner_activation(
  p_checkout_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_message_id text default null,
  p_last_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_status text := upper(pg_catalog.btrim(coalesce(p_status, '')));
  normalized_provider_id text := nullif(
    pg_catalog.btrim(coalesce(p_provider_message_id, '')),
    ''
  );
  changed_checkout_id uuid;
begin
  if p_checkout_id is null or p_claim_token is null
     or normalized_status not in ('SENT', 'FAILED', 'UNKNOWN')
     or length(coalesce(normalized_provider_id, '')) > 240
  then
    raise exception using
      errcode = '22023', message = 'invalid_saas_owner_activation_finish';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'saas-owner-activation:' || p_checkout_id::text,
      0
    )
  );

  update public.saas_owner_activation_attempts
     set status = normalized_status,
         provider_message_id = normalized_provider_id,
         provider_payload = case
           when normalized_status = 'UNKNOWN' then provider_payload
           else null
         end,
         provider_payload_sha256 = case
           when normalized_status = 'UNKNOWN' then provider_payload_sha256
           else null
         end,
         provider_payload_staged_at = case
           when normalized_status = 'UNKNOWN' then provider_payload_staged_at
           else null
         end,
         lease_expires_at = pg_catalog.now(),
         completed_at = pg_catalog.now(),
         last_error = nullif(left(coalesce(p_last_error, ''), 500), ''),
         updated_at = pg_catalog.now()
   where checkout_id = p_checkout_id
     and claim_token = p_claim_token
     and status = 'SUBMITTING'
     and submit_attempt_count between 1 and 5
   returning checkout_id into changed_checkout_id;

  return pg_catalog.jsonb_build_object(
    'ok', changed_checkout_id is not null,
    'action', case
      when changed_checkout_id is null then 'REVIEW_REQUIRED'
      else 'FINALIZED'
    end,
    'status', case
      when changed_checkout_id is null then null
      else normalized_status
    end,
    'reason', case
      when changed_checkout_id is null then 'activation_submit_state_lost'
      else null
    end
  );
end;
$function$;

alter function private.ensure_saas_owner_access_locked(uuid, text, text, uuid, boolean)
  owner to postgres;
alter function private.saas_owner_identity_is_dormant_for_activation(
  uuid, uuid, uuid, text
) owner to postgres;
alter function public.claim_saas_owner_activation(uuid, text, text, uuid, integer)
  owner to postgres;
alter function public.classify_saas_owner_activation_identity(uuid, uuid, uuid)
  owner to postgres;
alter function public.stage_saas_owner_activation_payload(uuid, uuid, uuid, text)
  owner to postgres;
alter function public.suppress_saas_owner_activation(uuid, uuid, uuid, text)
  owner to postgres;
alter function public.repair_saas_owner_access(uuid, uuid)
  owner to postgres;
alter function public.mark_saas_owner_activation_submitting(uuid, uuid, uuid)
  owner to postgres;
alter function public.finish_saas_owner_activation(uuid, uuid, text, text, text)
  owner to postgres;

revoke all on function private.ensure_saas_owner_access_locked(uuid, text, text, uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.saas_owner_identity_is_dormant_for_activation(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.claim_saas_owner_activation(uuid, text, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.classify_saas_owner_activation_identity(
  uuid, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.stage_saas_owner_activation_payload(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.suppress_saas_owner_activation(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.repair_saas_owner_access(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.mark_saas_owner_activation_submitting(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.finish_saas_owner_activation(uuid, uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.claim_saas_owner_activation(uuid, text, text, uuid, integer)
  to service_role;
grant execute on function public.classify_saas_owner_activation_identity(
  uuid, uuid, uuid
) to service_role;
grant execute on function public.stage_saas_owner_activation_payload(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.suppress_saas_owner_activation(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.repair_saas_owner_access(uuid, uuid)
  to service_role;
grant execute on function public.mark_saas_owner_activation_submitting(uuid, uuid, uuid)
  to service_role;
grant execute on function public.finish_saas_owner_activation(uuid, uuid, text, text, text)
  to service_role;

do $postconditions$
begin
  if pg_catalog.to_regclass('public.saas_owner_activation_attempts') is null
     or pg_catalog.to_regprocedure(
       'private.ensure_saas_owner_access_locked(uuid,text,text,uuid,boolean)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.saas_owner_identity_is_dormant_for_activation(uuid,uuid,uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.claim_saas_owner_activation(uuid,text,text,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.classify_saas_owner_activation_identity(uuid,uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.mark_saas_owner_activation_submitting(uuid,uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.stage_saas_owner_activation_payload(uuid,uuid,uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.suppress_saas_owner_activation(uuid,uuid,uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.repair_saas_owner_access(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.finish_saas_owner_activation(uuid,uuid,text,text,text)'
     ) is null
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.saas_owner_activation_attempts', 'SELECT'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'private.ensure_saas_owner_access_locked(uuid,text,text,uuid,boolean)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'private.ensure_saas_owner_access_locked(uuid,text,text,uuid,boolean)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'private.saas_owner_identity_is_dormant_for_activation(uuid,uuid,uuid,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.claim_saas_owner_activation(uuid,text,text,uuid,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.classify_saas_owner_activation_identity(uuid,uuid,uuid)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.stage_saas_owner_activation_payload(uuid,uuid,uuid,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.suppress_saas_owner_activation(uuid,uuid,uuid,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.repair_saas_owner_access(uuid,uuid)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.mark_saas_owner_activation_submitting(uuid,uuid,uuid)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.finish_saas_owner_activation(uuid,uuid,text,text,text)',
       'EXECUTE'
     )
     or exists (
       select 1
         from public.saas_checkout_intents as checkout
        where checkout.status = 'PROVISIONED'
          and checkout.tenant_id is not null
          and length(lower(pg_catalog.btrim(checkout.owner_email)))
            between 3 and 320
          and not exists (
            select 1
              from public.saas_owner_activation_attempts as attempt
             where attempt.checkout_id = checkout.id
          )
     )
  then
    raise exception 'saas_owner_activation_fence_installation_invalid';
  end if;
end;
$postconditions$;
