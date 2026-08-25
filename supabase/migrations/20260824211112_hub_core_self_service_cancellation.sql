begin;

create or replace function private.hub_catalog_is_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    coalesce((
      select case
        when pg_catalog.jsonb_typeof(settings.metadata -> 'catalogReady') =
             'boolean'
          then (settings.metadata ->> 'catalogReady')::boolean
        else true
      end
      from public.hub_settings as settings
      where settings.settings_key = 'default'
    ), true)
    and exists (
      select 1
      from public.hub_content_items as item
      where item.is_active = true
        and item.catalog_scope = 'COMMERCIAL_GLOBAL'
        and item.rights_basis in ('OWNED', 'LICENSED', 'PUBLIC_DOMAIN')
        and item.published_at is not null
        and item.published_at <= pg_catalog.now()
        and item.preview_enabled = true
        and item.rights_verified_at is not null
        and nullif(pg_catalog.btrim(item.license_summary), '') is not null
        and exists (
          select 1
          from public.hub_content_assets as full_asset
          join storage.objects as full_object
            on full_object.bucket_id = full_asset.bucket_id
           and full_object.name = full_asset.object_path
          where full_asset.content_id = item.id
            and full_asset.asset_kind = 'FULL'
            and pg_catalog.btrim(full_asset.object_path) <> ''
        )
        and exists (
          select 1
          from public.hub_content_assets as preview_asset
          join storage.objects as preview_object
            on preview_object.bucket_id = preview_asset.bucket_id
           and preview_object.name = preview_asset.object_path
          where preview_asset.content_id = item.id
            and preview_asset.asset_kind = 'PREVIEW'
            and pg_catalog.btrim(preview_asset.object_path) <> ''
        )
    );
$function$;

alter function private.hub_catalog_is_ready() owner to postgres;

create or replace function private.hub_public_settings_internal()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.jsonb_build_object(
      'settings_key', settings.settings_key,
      'brand_name', settings.brand_name,
      'headline', settings.headline,
      'subheadline', settings.subheadline,
      'saas_video_url', settings.saas_video_url,
      'saas_cta_url', settings.saas_cta_url,
      'support_url', settings.support_url,
      'metadata', pg_catalog.jsonb_build_object(
        'hubEnabled', case
          when pg_catalog.jsonb_typeof(settings.metadata -> 'hubEnabled') =
               'boolean'
            then (settings.metadata ->> 'hubEnabled')::boolean
          else true
        end,
        'catalogReady', private.hub_catalog_is_ready()
      )
    )
    from public.hub_settings as settings
    where settings.settings_key = 'default'
  ), pg_catalog.jsonb_build_object(
    'metadata', pg_catalog.jsonb_build_object(
      'hubEnabled', true,
      'catalogReady', false
    )
  ));
$function$;

create or replace function private.hub_guard_core_checkout_creation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.product_family <> 'HUB_CORE'
     or new.status not in ('CREATED', 'PENDING') then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-core-cancellation:' || new.account_id::text,
      0
    )
  );

  if not private.hub_catalog_is_ready() then
    raise exception 'hub_catalog_not_ready' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.hub_subscriptions as subscription
    where subscription.account_id = new.account_id
      and subscription.product_family = 'HUB_CORE'
      and subscription.status = 'ACTIVE'
      and subscription.current_period_ends_at > pg_catalog.now()
      and (
        (
          pg_catalog.jsonb_typeof(
            subscription.metadata -> 'cancelAtPeriodEnd'
          ) = 'boolean'
          and (subscription.metadata ->> 'cancelAtPeriodEnd')::boolean
        )
        or (
          pg_catalog.jsonb_typeof(
            subscription.metadata -> 'cancellationInProgress'
          ) = 'boolean'
          and (subscription.metadata ->> 'cancellationInProgress')::boolean
        )
      )
  ) then
    raise exception 'hub_subscription_cancellation_pending'
      using errcode = '55000';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_hub_guard_core_checkout_creation
  on public.hub_checkout_sessions;
create trigger trg_hub_guard_core_checkout_creation
before insert or update on public.hub_checkout_sessions
for each row execute function private.hub_guard_core_checkout_creation();

create or replace function private.hub_begin_core_cancellation_internal(
  p_account_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_subscription public.hub_subscriptions%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_account_id is null or p_actor_user_id is null then
    raise exception 'invalid_hub_cancellation_request'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-core-cancellation:' || p_account_id::text,
      0
    )
  );

  if not exists (
    select 1
    from public.hub_accounts as account
    where account.id = p_account_id
      and account.status = 'ACTIVE'
  ) then
    raise exception 'hub_account_inactive_or_missing' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.hub_memberships as membership
    where membership.account_id = p_account_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'ACTIVE'
      and membership.membership_role in ('OWNER', 'ADMIN')
  ) then
    raise exception 'hub_manager_required' using errcode = '42501';
  end if;

  select subscription.* into v_subscription
  from public.hub_subscriptions as subscription
  where subscription.account_id = p_account_id
    and subscription.product_family = 'HUB_CORE'
    and subscription.status = 'ACTIVE'
    and subscription.current_period_ends_at > pg_catalog.now()
  order by subscription.created_at desc, subscription.id desc
  limit 1
  for update;
  if not found then
    raise exception 'hub_active_paid_subscription_required'
      using errcode = '55000';
  end if;
  if v_subscription.provider is distinct from 'ASAAS'
     or nullif(pg_catalog.btrim(v_subscription.provider_subscription_id), '')
        is null then
    raise exception 'hub_subscription_reconciliation_required'
      using errcode = '55000';
  end if;

  if pg_catalog.jsonb_typeof(
       v_subscription.metadata -> 'cancelAtPeriodEnd'
     ) = 'boolean'
     and (v_subscription.metadata ->> 'cancelAtPeriodEnd')::boolean then
    return pg_catalog.jsonb_build_object(
      'success', true,
      'idempotent', true,
      'subscriptionId', v_subscription.id,
      'cancelAtPeriodEnd', true
    );
  end if;

  update public.hub_subscriptions as subscription
  set metadata = coalesce(subscription.metadata, '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'cancellationInProgress', true,
          'cancellationInProgressAt', v_now,
          'cancellationInProgressBy', p_actor_user_id
        ),
      updated_at = v_now
  where subscription.id = v_subscription.id;

  return pg_catalog.jsonb_build_object(
    'success', true,
    'idempotent', false,
    'subscriptionId', v_subscription.id,
    'cancellationInProgress', true
  );
end;
$function$;

create or replace function public.hub_begin_core_cancellation(
  p_account_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.hub_begin_core_cancellation_internal(
    p_account_id,
    p_actor_user_id
  );
$function$;

create or replace function private.hub_guard_core_subscription_activation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_is_new_live_period boolean := false;
begin
  if new.product_family <> 'HUB_CORE'
     or new.status not in ('TRIALING', 'ACTIVE') then
    return new;
  end if;

  v_is_new_live_period := tg_op = 'INSERT';
  if tg_op = 'UPDATE' then
    v_is_new_live_period := old.status not in ('TRIALING', 'ACTIVE')
      or old.product_family is distinct from new.product_family;
  end if;

  if v_is_new_live_period and not private.hub_catalog_is_ready() then
    raise exception 'hub_catalog_not_ready' using errcode = '55000';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_hub_guard_core_subscription_activation
  on public.hub_subscriptions;
create trigger trg_hub_guard_core_subscription_activation
before insert or update on public.hub_subscriptions
for each row execute function
  private.hub_guard_core_subscription_activation();

create or replace function private.hub_schedule_core_cancellation_internal(
  p_account_id uuid,
  p_actor_user_id uuid,
  p_cancelled_provider_subscription_ids text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_account public.hub_accounts%rowtype;
  v_subscription public.hub_subscriptions%rowtype;
  v_checkout record;
  v_cancelled_ids text[] := coalesce(
    p_cancelled_provider_subscription_ids,
    '{}'::text[]
  );
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_existing_cancel_at_period_end boolean := false;
begin
  if p_account_id is null or p_actor_user_id is null then
    raise exception 'invalid_hub_cancellation_request'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.unnest(v_cancelled_ids) as supplied(provider_id)
    where supplied.provider_id is null
      or pg_catalog.char_length(pg_catalog.btrim(supplied.provider_id)) < 1
      or pg_catalog.char_length(pg_catalog.btrim(supplied.provider_id)) > 200
  ) then
    raise exception 'invalid_provider_subscription_id'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-core-cancellation:' || p_account_id::text,
      0
    )
  );

  select account.* into v_account
  from public.hub_accounts as account
  where account.id = p_account_id
  for update;
  if not found then
    raise exception 'hub_account_not_found' using errcode = 'P0002';
  end if;
  if v_account.status <> 'ACTIVE' then
    raise exception 'hub_account_inactive' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.hub_memberships as membership
    where membership.account_id = p_account_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'ACTIVE'
      and membership.membership_role in ('OWNER', 'ADMIN')
  ) then
    raise exception 'hub_manager_required' using errcode = '42501';
  end if;

  select subscription.* into v_subscription
  from public.hub_subscriptions as subscription
  where subscription.account_id = p_account_id
    and subscription.product_family = 'HUB_CORE'
    and subscription.status = 'ACTIVE'
    and subscription.current_period_ends_at > pg_catalog.now()
  order by subscription.created_at desc, subscription.id desc
  limit 1
  for update;

  if not found then
    select subscription.* into v_subscription
    from public.hub_subscriptions as subscription
    where subscription.account_id = p_account_id
      and subscription.product_family = 'HUB_CORE'
      and pg_catalog.jsonb_typeof(
        subscription.metadata -> 'cancelAtPeriodEnd'
      ) = 'boolean'
      and (subscription.metadata ->> 'cancelAtPeriodEnd')::boolean
    order by subscription.created_at desc, subscription.id desc
    limit 1
    for update;
    if found then
      return pg_catalog.jsonb_build_object(
        'success', true,
        'idempotent', true,
        'accountId', p_account_id,
        'subscriptionId', v_subscription.id,
        'status', v_subscription.status,
        'cancelAtPeriodEnd', true,
        'accessEndsAt', v_subscription.current_period_ends_at,
        'cancellationRequestedAt',
          v_subscription.metadata ->> 'cancellationRequestedAt'
      );
    end if;
    raise exception 'hub_active_paid_subscription_required'
      using errcode = '55000';
  end if;

  v_existing_cancel_at_period_end :=
    pg_catalog.jsonb_typeof(
      v_subscription.metadata -> 'cancelAtPeriodEnd'
    ) = 'boolean'
    and (v_subscription.metadata ->> 'cancelAtPeriodEnd')::boolean;
  if v_existing_cancel_at_period_end then
    return pg_catalog.jsonb_build_object(
      'success', true,
      'idempotent', true,
      'accountId', p_account_id,
      'subscriptionId', v_subscription.id,
      'status', v_subscription.status,
      'cancelAtPeriodEnd', true,
      'accessEndsAt', v_subscription.current_period_ends_at,
      'cancellationRequestedAt',
        v_subscription.metadata ->> 'cancellationRequestedAt'
    );
  end if;

  if v_subscription.provider is distinct from 'ASAAS'
     or nullif(pg_catalog.btrim(v_subscription.provider_subscription_id), '')
        is null then
    raise exception 'hub_subscription_reconciliation_required'
      using errcode = '55000';
  end if;
  if not (
    v_subscription.provider_subscription_id = any(v_cancelled_ids)
  ) then
    raise exception 'hub_provider_cancellation_not_confirmed'
      using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-subscription:' ||
        v_subscription.provider_subscription_id,
      0
    )
  );

  for v_checkout in
    select
      checkout.id,
      checkout.status,
      checkout.asaas_subscription_id,
      checkout.asaas_payment_id
    from public.hub_checkout_sessions as checkout
    where checkout.account_id = p_account_id
      and checkout.product_family = 'HUB_CORE'
      and checkout.status in ('CREATED', 'PENDING', 'OVERDUE', 'PAID')
    order by checkout.created_at, checkout.id
    for update of checkout
  loop
    if nullif(pg_catalog.btrim(v_checkout.asaas_subscription_id), '')
       is null then
      if v_checkout.status <> 'CREATED'
         or nullif(pg_catalog.btrim(v_checkout.asaas_payment_id), '')
            is not null then
        raise exception 'hub_checkout_reconciliation_required'
          using errcode = '55000';
      end if;
      continue;
    end if;
    if not (v_checkout.asaas_subscription_id = any(v_cancelled_ids)) then
      raise exception 'hub_provider_cancellation_not_confirmed'
        using errcode = '55000';
    end if;
  end loop;

  update public.hub_subscriptions as subscription
  set cancelled_at = coalesce(subscription.cancelled_at, v_now),
      metadata = (
        coalesce(subscription.metadata, '{}'::jsonb)
          - 'cancellationInProgress'
          - 'cancellationInProgressAt'
          - 'cancellationInProgressBy'
      )
        || pg_catalog.jsonb_build_object(
          'cancelAtPeriodEnd', true,
          'cancellationRequestedAt', v_now,
          'providerCancellationConfirmedAt', v_now,
          'accessEndsAt', subscription.current_period_ends_at,
          'cancellationRequestedBy', p_actor_user_id
        ),
      updated_at = v_now
  where subscription.id = v_subscription.id
  returning subscription.* into v_subscription;

  update public.hub_checkout_sessions as checkout
  set status = 'CANCELLED',
      metadata = coalesce(checkout.metadata, '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'cancelAtPeriodEnd', true,
          'cancellationRequestedAt', v_now,
          'providerCancellationConfirmedAt', v_now,
          'accessEndsAt', v_subscription.current_period_ends_at
        ),
      updated_at = v_now
  where checkout.account_id = p_account_id
    and checkout.product_family = 'HUB_CORE'
    and checkout.status in ('CREATED', 'PENDING', 'OVERDUE', 'PAID');

  insert into public.hub_conversion_events (
    account_id,
    user_id,
    event_name,
    source,
    metadata
  ) values (
    p_account_id,
    p_actor_user_id,
    'hub_subscription_cancellation_scheduled',
    'hub_self_service',
    pg_catalog.jsonb_build_object(
      'subscriptionId', v_subscription.id,
      'cancelAtPeriodEnd', true,
      'accessEndsAt', v_subscription.current_period_ends_at,
      'providerSubscriptionsCancelled', v_cancelled_ids
    )
  );

  return pg_catalog.jsonb_build_object(
    'success', true,
    'idempotent', false,
    'accountId', p_account_id,
    'subscriptionId', v_subscription.id,
    'status', v_subscription.status,
    'cancelAtPeriodEnd', true,
    'accessEndsAt', v_subscription.current_period_ends_at,
    'cancellationRequestedAt', v_now
  );
end;
$function$;

create or replace function public.hub_schedule_core_cancellation(
  p_account_id uuid,
  p_actor_user_id uuid,
  p_cancelled_provider_subscription_ids text[] default '{}'::text[]
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.hub_schedule_core_cancellation_internal(
    p_account_id,
    p_actor_user_id,
    p_cancelled_provider_subscription_ids
  );
$function$;

create or replace function private.expire_hub_core_cancellations_internal()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_expired integer := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  update public.hub_subscriptions as subscription
  set status = 'EXPIRED',
      metadata = coalesce(subscription.metadata, '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'cancelAtPeriodEnd', true,
          'accessEndedAt', subscription.current_period_ends_at,
          'expiredAt', v_now,
          'expiredBy', 'hub_core_period_expiration'
        ),
      updated_at = v_now
  where subscription.product_family = 'HUB_CORE'
    and subscription.status in ('ACTIVE', 'PAST_DUE')
    and subscription.current_period_ends_at is not null
    and subscription.current_period_ends_at <= pg_catalog.now()
    and pg_catalog.jsonb_typeof(
      subscription.metadata -> 'cancelAtPeriodEnd'
    ) = 'boolean'
    and (subscription.metadata ->> 'cancelAtPeriodEnd')::boolean;

  get diagnostics v_expired = row_count;
  return v_expired;
end;
$function$;

select private.expire_hub_core_cancellations_internal();

do $cron$
begin
  if exists (
    select 1
    from pg_catalog.pg_extension
    where extname = 'pg_cron'
  ) then
    perform cron.unschedule('wisewolf-expire-hub-core-cancellations')
    where exists (
      select 1
      from cron.job
      where jobname = 'wisewolf-expire-hub-core-cancellations'
    );
    perform cron.schedule(
      'wisewolf-expire-hub-core-cancellations',
      '*/5 * * * *',
      'select private.expire_hub_core_cancellations_internal();'
    );
  end if;
end;
$cron$;

do $move_activation$
begin
  if pg_catalog.to_regprocedure(
       'private.hub_activate_paid_checkout_apply(uuid,text)'
     ) is null then
    if pg_catalog.to_regprocedure(
         'public.hub_activate_paid_checkout(uuid,text)'
       ) is null then
      raise exception 'hub_activate_paid_checkout_missing'
        using errcode = '55000';
    end if;
    alter function public.hub_activate_paid_checkout(uuid, text)
      set schema private;
    alter function private.hub_activate_paid_checkout(uuid, text)
      rename to hub_activate_paid_checkout_apply;
  end if;
end;
$move_activation$;

create or replace function public.hub_activate_paid_checkout(
  p_checkout_id uuid,
  p_payment_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_checkout public.hub_checkout_sessions%rowtype;
  v_subscription public.hub_subscriptions%rowtype;
  v_payment_id text := nullif(pg_catalog.btrim(p_payment_id), '');
begin
  if p_checkout_id is null
     or v_payment_id is null
     or pg_catalog.char_length(v_payment_id) > 200 then
    raise exception 'invalid_hub_payment' using errcode = '22023';
  end if;

  select checkout.* into v_checkout
  from public.hub_checkout_sessions as checkout
  where checkout.id = p_checkout_id
  for update;
  if not found then
    return private.hub_activate_paid_checkout_apply(
      p_checkout_id,
      v_payment_id
    );
  end if;

  if v_checkout.product_family = 'HUB_CORE' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'hub-provider-subscription:' || coalesce(
          nullif(v_checkout.asaas_subscription_id, ''),
          v_checkout.id::text
        ),
        0
      )
    );

    select subscription.* into v_subscription
    from public.hub_subscriptions as subscription
    where subscription.account_id = v_checkout.account_id
      and subscription.product_family = 'HUB_CORE'
      and (
        (
          pg_catalog.jsonb_typeof(
            subscription.metadata -> 'cancelAtPeriodEnd'
          ) = 'boolean'
          and (subscription.metadata ->> 'cancelAtPeriodEnd')::boolean
        )
        or (
          pg_catalog.jsonb_typeof(
            subscription.metadata -> 'cancellationInProgress'
          ) = 'boolean'
          and (subscription.metadata ->> 'cancellationInProgress')::boolean
        )
      )
      and (
        (
          nullif(v_checkout.asaas_subscription_id, '') is not null
          and subscription.provider = 'ASAAS'
          and subscription.provider_subscription_id =
            v_checkout.asaas_subscription_id
        )
        or subscription.metadata ->> 'checkoutId' = v_checkout.id::text
      )
    order by subscription.created_at desc, subscription.id desc
    limit 1
    for update;

    if (
         pg_catalog.jsonb_typeof(
           v_checkout.metadata -> 'cancelAtPeriodEnd'
         ) = 'boolean'
         and (v_checkout.metadata ->> 'cancelAtPeriodEnd')::boolean
       ) or v_subscription.id is not null then
      update public.hub_checkout_sessions as checkout
      set metadata = coalesce(checkout.metadata, '{}'::jsonb)
            || pg_catalog.jsonb_build_object(
              'postCancellationPaymentObservedAt', pg_catalog.now(),
              'postCancellationPaymentId', v_payment_id,
              'requiresManualReconciliation', true
            ),
          updated_at = pg_catalog.now()
      where checkout.id = v_checkout.id;

      return pg_catalog.jsonb_build_object(
        'accountId', v_checkout.account_id,
        'subscriptionId', v_subscription.id,
        'status', coalesce(v_subscription.status, 'CANCELLED'),
        'idempotent', true,
        'applied', false,
        'cancelAtPeriodEnd', true,
        'periodEndsAt', v_subscription.current_period_ends_at
      );
    end if;
  end if;

  return private.hub_activate_paid_checkout_apply(
    p_checkout_id,
    v_payment_id
  );
end;
$function$;

alter function private.hub_public_settings_internal() owner to postgres;
alter function private.hub_guard_core_checkout_creation() owner to postgres;
alter function private.hub_guard_core_subscription_activation()
  owner to postgres;
alter function private.hub_begin_core_cancellation_internal(uuid, uuid)
  owner to postgres;
alter function public.hub_begin_core_cancellation(uuid, uuid)
  owner to postgres;
alter function private.hub_schedule_core_cancellation_internal(
  uuid, uuid, text[]
) owner to postgres;
alter function public.hub_schedule_core_cancellation(uuid, uuid, text[])
  owner to postgres;
alter function private.expire_hub_core_cancellations_internal()
  owner to postgres;
alter function private.hub_activate_paid_checkout_apply(uuid, text)
  owner to postgres;
alter function public.hub_activate_paid_checkout(uuid, text)
  owner to postgres;

revoke all on function private.hub_catalog_is_ready()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_public_settings_internal()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_guard_core_checkout_creation()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_guard_core_subscription_activation()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_begin_core_cancellation_internal(
  uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.hub_begin_core_cancellation(
  uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function private.hub_schedule_core_cancellation_internal(
  uuid, uuid, text[]
) from public, anon, authenticated, service_role;
revoke all on function public.hub_schedule_core_cancellation(
  uuid, uuid, text[]
) from public, anon, authenticated, service_role;
revoke all on function private.expire_hub_core_cancellations_internal()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_activate_paid_checkout_apply(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hub_activate_paid_checkout(uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function private.hub_schedule_core_cancellation_internal(
  uuid, uuid, text[]
) to service_role;
grant execute on function private.hub_begin_core_cancellation_internal(
  uuid, uuid
) to service_role;
grant execute on function public.hub_begin_core_cancellation(
  uuid, uuid
) to service_role;
grant execute on function public.hub_schedule_core_cancellation(
  uuid, uuid, text[]
) to service_role;
grant execute on function public.hub_activate_paid_checkout(uuid, text)
  to service_role;

comment on function public.hub_schedule_core_cancellation(
  uuid, uuid, text[]
) is
  'Service-only finalization after every account-scoped Asaas recurrence was cancelled by the authenticated Hub manager flow.';
comment on function public.hub_begin_core_cancellation(uuid, uuid) is
  'Service-only synchronization barrier that blocks new Hub Core provider links while an authenticated manager cancels the existing Asaas recurrence.';
comment on function private.expire_hub_core_cancellations_internal() is
  'Idempotently expires Hub Core access after a confirmed cancel-at-period-end request reaches its paid boundary.';
comment on function public.hub_activate_paid_checkout(uuid, text) is
  'Service-only billing activation wrapper that refuses to extend a provider schedule already cancelled at period end.';

commit;
