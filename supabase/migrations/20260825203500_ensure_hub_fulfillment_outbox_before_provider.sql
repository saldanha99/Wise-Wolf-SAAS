set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- A Hub checkout is the local root of both the Asaas subscription and the
-- post-payment delivery.  Persist a frozen delivery snapshot with that root
-- and materialize both outbox rows transactionally before any provider POST.
do $requirements$
begin
  if pg_catalog.to_regclass('public.hub_checkout_sessions') is null
     or pg_catalog.to_regclass('public.hub_fulfillment_outbox') is null
     or pg_catalog.to_regprocedure(
       'private.hub_service_role_required()'
     ) is null then
    raise exception 'hub_fulfillment_provider_fence_dependencies_missing';
  end if;
end;
$requirements$;

create or replace function private.hub_checkout_fulfillment_snapshot_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (old.metadata ? 'fulfillment_snapshot')
     and (
       not (new.metadata ? 'fulfillment_snapshot')
       or old.metadata -> 'fulfillment_snapshot'
         is distinct from new.metadata -> 'fulfillment_snapshot'
     ) then
    raise exception 'hub_checkout_fulfillment_snapshot_immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_hub_checkout_fulfillment_snapshot_immutable
  on public.hub_checkout_sessions;
create trigger trg_hub_checkout_fulfillment_snapshot_immutable
before update of metadata on public.hub_checkout_sessions
for each row
execute function private.hub_checkout_fulfillment_snapshot_immutable();

create or replace function public.hub_ensure_checkout_fulfillment_outbox(
  p_checkout_id uuid,
  p_account_id uuid,
  p_plan_id uuid,
  p_requested_by uuid,
  p_product_family text,
  p_email_recipient text,
  p_whatsapp_recipient text,
  p_recipient_name text,
  p_test_fixture boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_checkout public.hub_checkout_sessions%rowtype;
  v_snapshot jsonb;
  v_expected_snapshot jsonb;
  v_delivery_metadata jsonb;
  v_plan_code text;
  v_plan_name text;
  v_existing_count bigint := 0;
  v_exact_count bigint := 0;
  v_preinsert_count bigint := 0;
  v_action text := 'STAGED';
begin
  perform private.hub_service_role_required();

  if p_checkout_id is null
     or p_account_id is null
     or p_plan_id is null
     or p_requested_by is null
     or p_product_family not in ('HUB_CORE', 'WOLFIE_STANDALONE')
     or p_email_recipient is null
     or p_email_recipient <> pg_catalog.lower(
       pg_catalog.btrim(p_email_recipient)
     )
     or pg_catalog.char_length(p_email_recipient) not between 3 and 320
     or pg_catalog.strpos(p_email_recipient, '@') <= 1
     or p_whatsapp_recipient is null
     or p_whatsapp_recipient !~ '^[0-9]{10,13}$'
     or p_recipient_name is null
     or p_recipient_name <> pg_catalog.btrim(p_recipient_name)
     or pg_catalog.char_length(p_recipient_name) not between 1 and 160
     or p_test_fixture is null then
    raise exception 'invalid_hub_fulfillment_fence_input'
      using errcode = '22023';
  end if;

  select checkout.*
  into v_checkout
  from public.hub_checkout_sessions as checkout
  where checkout.id = p_checkout_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'checkout_not_found'
    );
  end if;

  if v_checkout.account_id is distinct from p_account_id
     or v_checkout.plan_id is distinct from p_plan_id
     or v_checkout.requested_by is distinct from p_requested_by
     or v_checkout.product_family is distinct from p_product_family
     or v_checkout.status <> 'CREATED' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'checkout_identity_or_status_changed'
    );
  end if;

  select pg_catalog.count(*)
  into v_existing_count
  from public.hub_fulfillment_outbox as delivery
  where delivery.checkout_id = p_checkout_id;

  v_snapshot := v_checkout.metadata -> 'fulfillment_snapshot';
  v_delivery_metadata := case
    when p_test_fixture then '{"test_fixture":true}'::jsonb
    else '{}'::jsonb
  end;

  -- Checkouts created by the old code may already have the complete exact
  -- outbox but no frozen snapshot.  That state is safe to adopt.  A legacy
  -- checkout with no outbox is intentionally quarantined: current request
  -- data cannot prove what the original recipients were.
  if v_snapshot is null then
    if v_existing_count <> 2 then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'legacy_fulfillment_snapshot_missing'
      );
    end if;

    select delivery.plan_code, delivery.plan_name
    into v_plan_code, v_plan_name
    from public.hub_fulfillment_outbox as delivery
    where delivery.checkout_id = p_checkout_id
      and delivery.channel = 'EMAIL';

    if not found then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'legacy_fulfillment_identity_conflict'
      );
    end if;

    v_snapshot := pg_catalog.jsonb_build_object(
      'version', 1,
      'account_id', p_account_id,
      'user_id', p_requested_by,
      'plan_id', p_plan_id,
      'product_family', p_product_family,
      'plan_code', v_plan_code,
      'plan_name', v_plan_name,
      'email_recipient', p_email_recipient,
      'whatsapp_recipient', p_whatsapp_recipient,
      'recipient_name', p_recipient_name,
      'test_fixture', p_test_fixture
    );

    select pg_catalog.count(*)
    into v_exact_count
    from public.hub_fulfillment_outbox as delivery
    where delivery.checkout_id = p_checkout_id
      and delivery.account_id = p_account_id
      and delivery.user_id = p_requested_by
      and delivery.product_family = p_product_family
      and delivery.plan_code = v_plan_code
      and delivery.plan_name = v_plan_name
      and delivery.recipient_name = p_recipient_name
      and delivery.recipient = case delivery.channel
        when 'EMAIL' then p_email_recipient
        when 'WHATSAPP' then p_whatsapp_recipient
      end
      and delivery.metadata = v_delivery_metadata
      and delivery.subscription_id is null
      and delivery.status = 'WAITING_PAYMENT'
      and delivery.attempt_count = 0
      and delivery.lease_token is null
      and delivery.lease_expires_at is null
      and delivery.provider_dispatch_started_at is null
      and delivery.provider_message_id is null
      and delivery.last_error is null
      and delivery.completed_at is null;

    if v_exact_count <> 2
       or pg_catalog.char_length(v_plan_code) not between 1 and 64
       or pg_catalog.char_length(v_plan_name) not between 1 and 160 then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'legacy_fulfillment_identity_conflict'
      );
    end if;

    update public.hub_checkout_sessions as checkout
    set metadata = pg_catalog.jsonb_set(
          checkout.metadata,
          '{fulfillment_snapshot}',
          v_snapshot,
          true
        ),
        updated_at = pg_catalog.clock_timestamp()
    where checkout.id = p_checkout_id;
    v_action := 'LEGACY_ADOPTED';
  end if;

  if pg_catalog.jsonb_typeof(v_snapshot) <> 'object' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'fulfillment_snapshot_invalid'
    );
  end if;

  v_plan_code := v_snapshot ->> 'plan_code';
  v_plan_name := v_snapshot ->> 'plan_name';
  v_expected_snapshot := pg_catalog.jsonb_build_object(
    'version', 1,
    'account_id', p_account_id,
    'user_id', p_requested_by,
    'plan_id', p_plan_id,
    'product_family', p_product_family,
    'plan_code', v_plan_code,
    'plan_name', v_plan_name,
    'email_recipient', p_email_recipient,
    'whatsapp_recipient', p_whatsapp_recipient,
    'recipient_name', p_recipient_name,
    'test_fixture', p_test_fixture
  );

  if v_snapshot <> v_expected_snapshot
     or v_plan_code is null
     or v_plan_name is null
     or pg_catalog.char_length(v_plan_code) not between 1 and 64
     or pg_catalog.char_length(v_plan_name) not between 1 and 160 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'fulfillment_snapshot_mismatch'
    );
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (
      where delivery.account_id = p_account_id
        and delivery.user_id = p_requested_by
        and delivery.product_family = p_product_family
        and delivery.plan_code = v_plan_code
        and delivery.plan_name = v_plan_name
        and delivery.recipient_name = p_recipient_name
        and delivery.recipient = case delivery.channel
          when 'EMAIL' then p_email_recipient
          when 'WHATSAPP' then p_whatsapp_recipient
        end
        and delivery.metadata = v_delivery_metadata
        and delivery.subscription_id is null
        and delivery.status = 'WAITING_PAYMENT'
        and delivery.attempt_count = 0
        and delivery.lease_token is null
        and delivery.lease_expires_at is null
        and delivery.provider_dispatch_started_at is null
        and delivery.provider_message_id is null
        and delivery.last_error is null
        and delivery.completed_at is null
    )
  into v_existing_count, v_exact_count
  from public.hub_fulfillment_outbox as delivery
  where delivery.checkout_id = p_checkout_id;

  if v_existing_count <> v_exact_count then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'fulfillment_outbox_identity_conflict'
    );
  end if;

  if v_existing_count = 2 then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', case
        when v_action = 'LEGACY_ADOPTED' then v_action
        else 'ALREADY_STAGED'
      end,
      'checkoutId', p_checkout_id,
      'rowCount', 2
    );
  end if;

  if v_existing_count not in (0, 1) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'fulfillment_outbox_cardinality_conflict'
    );
  end if;
  v_preinsert_count := v_existing_count;

  -- The exception block is a subtransaction.  If a concurrent privileged
  -- writer produces a conflicting row, the postcondition failure rolls back
  -- only our inserts and returns a fail-closed result.
  begin
    insert into public.hub_fulfillment_outbox (
      checkout_id,
      account_id,
      user_id,
      product_family,
      plan_code,
      plan_name,
      channel,
      recipient,
      recipient_name,
      metadata
    )
    values
      (
        p_checkout_id,
        p_account_id,
        p_requested_by,
        p_product_family,
        v_plan_code,
        v_plan_name,
        'EMAIL',
        p_email_recipient,
        p_recipient_name,
        v_delivery_metadata
      ),
      (
        p_checkout_id,
        p_account_id,
        p_requested_by,
        p_product_family,
        v_plan_code,
        v_plan_name,
        'WHATSAPP',
        p_whatsapp_recipient,
        p_recipient_name,
        v_delivery_metadata
      )
    on conflict (checkout_id, channel) do nothing;

    select
      pg_catalog.count(*),
      pg_catalog.count(*) filter (
        where delivery.account_id = p_account_id
          and delivery.user_id = p_requested_by
          and delivery.product_family = p_product_family
          and delivery.plan_code = v_plan_code
          and delivery.plan_name = v_plan_name
          and delivery.recipient_name = p_recipient_name
          and delivery.recipient = case delivery.channel
            when 'EMAIL' then p_email_recipient
            when 'WHATSAPP' then p_whatsapp_recipient
          end
          and delivery.metadata = v_delivery_metadata
          and delivery.subscription_id is null
          and delivery.status = 'WAITING_PAYMENT'
          and delivery.attempt_count = 0
          and delivery.lease_token is null
          and delivery.lease_expires_at is null
          and delivery.provider_dispatch_started_at is null
          and delivery.provider_message_id is null
          and delivery.last_error is null
          and delivery.completed_at is null
      )
    into v_existing_count, v_exact_count
    from public.hub_fulfillment_outbox as delivery
    where delivery.checkout_id = p_checkout_id;

    if v_existing_count <> 2 or v_exact_count <> 2 then
      raise exception 'hub_fulfillment_outbox_postcondition_failed'
        using errcode = 'P0F01';
    end if;
  exception
    when sqlstate 'P0F01' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'fulfillment_outbox_postcondition_failed'
      );
  end;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', case when v_preinsert_count = 1 then 'REPAIRED' else 'STAGED' end,
    'checkoutId', p_checkout_id,
    'rowCount', 2
  );
end;
$function$;

alter function private.hub_checkout_fulfillment_snapshot_immutable()
  owner to postgres;
alter function public.hub_ensure_checkout_fulfillment_outbox(
  uuid, uuid, uuid, uuid, text, text, text, text, boolean
) owner to postgres;

revoke all on function private.hub_checkout_fulfillment_snapshot_immutable()
  from public, anon, authenticated, service_role;
revoke all on function public.hub_ensure_checkout_fulfillment_outbox(
  uuid, uuid, uuid, uuid, text, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.hub_ensure_checkout_fulfillment_outbox(
  uuid, uuid, uuid, uuid, text, text, text, text, boolean
) to service_role;

comment on function public.hub_ensure_checkout_fulfillment_outbox(
  uuid, uuid, uuid, uuid, text, text, text, text, boolean
) is
  'Atomically proves the frozen Hub checkout identity and stages its exact email and WhatsApp outbox before any Asaas creation.';

do $postconditions$
begin
  if pg_catalog.to_regprocedure(
       'public.hub_ensure_checkout_fulfillment_outbox(uuid,uuid,uuid,uuid,text,text,text,text,boolean)'
     ) is null
     or not exists (
       select 1
       from pg_catalog.pg_trigger as trigger
       where trigger.tgrelid = 'public.hub_checkout_sessions'::regclass
         and trigger.tgname =
           'trg_hub_checkout_fulfillment_snapshot_immutable'
         and not trigger.tgisinternal
         and trigger.tgenabled <> 'D'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hub_ensure_checkout_fulfillment_outbox(uuid,uuid,uuid,uuid,text,text,text,text,boolean)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.hub_ensure_checkout_fulfillment_outbox(uuid,uuid,uuid,uuid,text,text,text,text,boolean)',
       'EXECUTE'
     ) then
    raise exception 'hub_fulfillment_provider_fence_installation_invalid';
  end if;
end;
$postconditions$;
