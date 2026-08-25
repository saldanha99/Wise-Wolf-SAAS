revoke update on table public.hub_accounts from anon, authenticated;
revoke update (name, audience, metadata)
  on table public.hub_accounts
  from anon, authenticated;

drop policy if exists hub_accounts_update_managers
  on public.hub_accounts;

create or replace function private.hub_update_preferences_internal(
  p_account_id uuid,
  p_preferences jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_preferences jsonb := coalesce(p_preferences, '{}'::jsonb);
  v_level text;
  v_role text;
  v_goal text;
  v_interests text;
  v_preferred_modality text;
  v_metadata_patch jsonb := '{}'::jsonb;
  v_updated_at timestamptz := pg_catalog.clock_timestamp();
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if p_account_id is null then
    raise exception 'invalid_account_id' using errcode = '22023';
  end if;
  if not private.hub_is_account_manager(p_account_id) then
    raise exception 'hub_manager_required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(v_preferences) <> 'object' then
    raise exception 'invalid_preferences' using errcode = '22023';
  end if;
  if pg_catalog.octet_length(v_preferences::text) > 2048 then
    raise exception 'preferences_too_large' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(v_preferences) as supplied(key)
    where not (
      supplied.key = any (
        array[
          'level',
          'role',
          'goal',
          'interests',
          'preferred_modality'
        ]::text[]
      )
    )
  ) then
    raise exception 'unsupported_preference_key' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_each(v_preferences) as supplied(key, value)
    where pg_catalog.jsonb_typeof(supplied.value) <> 'string'
  ) then
    raise exception 'invalid_preference_value' using errcode = '22023';
  end if;

  v_level := pg_catalog.upper(
    pg_catalog.btrim(coalesce(v_preferences->>'level', ''))
  );
  v_role := nullif(
    pg_catalog.btrim(coalesce(v_preferences->>'role', '')),
    ''
  );
  v_goal := nullif(
    pg_catalog.btrim(coalesce(v_preferences->>'goal', '')),
    ''
  );
  v_interests := nullif(
    pg_catalog.btrim(coalesce(v_preferences->>'interests', '')),
    ''
  );
  v_preferred_modality := pg_catalog.lower(
    pg_catalog.btrim(
      coalesce(v_preferences->>'preferred_modality', '')
    )
  );

  if v_preferences ? 'level'
     and v_level <> ''
     and v_level not in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2') then
    raise exception 'invalid_cefr_level' using errcode = '22023';
  end if;
  if pg_catalog.char_length(
       coalesce(v_preferences->>'role', '')
     ) > 120
     or pg_catalog.char_length(
       coalesce(v_preferences->>'goal', '')
     ) > 320
     or pg_catalog.char_length(
       coalesce(v_preferences->>'interests', '')
     ) > 320 then
    raise exception 'preferences_too_long' using errcode = '22023';
  end if;
  if v_preferences ? 'preferred_modality' then
    if v_preferred_modality = '' then
      v_preferred_modality := 'mixed';
    elsif v_preferred_modality not in ('text', 'voice', 'mixed') then
      raise exception 'invalid_preferred_modality' using errcode = '22023';
    end if;
  end if;

  v_metadata_patch := pg_catalog.jsonb_build_object(
    'onboarding_completed', true,
    'personalized_at', v_updated_at
  );
  if v_preferences ? 'level' then
    v_metadata_patch := v_metadata_patch || pg_catalog.jsonb_build_object(
      'level', nullif(v_level, '')
    );
  end if;
  if v_preferences ? 'role' then
    v_metadata_patch := v_metadata_patch || pg_catalog.jsonb_build_object(
      'role', v_role
    );
  end if;
  if v_preferences ? 'goal' then
    v_metadata_patch := v_metadata_patch || pg_catalog.jsonb_build_object(
      'goal', v_goal
    );
  end if;
  if v_preferences ? 'interests' then
    v_metadata_patch := v_metadata_patch || pg_catalog.jsonb_build_object(
      'interests', v_interests
    );
  end if;
  if v_preferences ? 'preferred_modality' then
    v_metadata_patch := v_metadata_patch || pg_catalog.jsonb_build_object(
      'preferred_modality', v_preferred_modality
    );
  end if;

  update public.hub_accounts as account
  set metadata = coalesce(account.metadata, '{}'::jsonb)
        || v_metadata_patch,
      updated_at = v_updated_at
  where account.id = p_account_id
    and account.status = 'ACTIVE'
  returning account.updated_at into v_updated_at;

  if not found then
    raise exception 'hub_account_inactive_or_missing' using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'accountId', p_account_id,
    'updatedAt', v_updated_at
  );
end;
$function$;

create or replace function public.hub_update_preferences(
  p_account_id uuid,
  p_preferences jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.hub_update_preferences_internal(
    p_account_id,
    p_preferences
  );
$function$;

revoke all on function private.hub_update_preferences_internal(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.hub_update_preferences(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.hub_update_preferences(uuid, jsonb)
  to authenticated;

comment on function public.hub_update_preferences(uuid, jsonb) is
  'Updates only allowlisted Hub personalization keys for an active account manager and returns accountId/updatedAt.';

create or replace function public.hub_rename_account(
  p_account_id uuid,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_name text := pg_catalog.btrim(
    pg_catalog.regexp_replace(
      coalesce(p_name, ''),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
  v_updated_at timestamptz := pg_catalog.clock_timestamp();
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if p_account_id is null then
    raise exception 'invalid_account_id' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_name) < 1
     or pg_catalog.char_length(v_name) > 120 then
    raise exception 'invalid_account_name' using errcode = '22023';
  end if;
  if not private.hub_is_account_manager(p_account_id) then
    raise exception 'hub_manager_required' using errcode = '42501';
  end if;

  update public.hub_accounts as account
  set name = v_name,
      updated_at = v_updated_at
  where account.id = p_account_id
    and account.status = 'ACTIVE'
  returning account.updated_at into v_updated_at;

  if not found then
    raise exception 'hub_account_inactive_or_missing' using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'accountId', p_account_id,
    'name', v_name,
    'updatedAt', v_updated_at
  );
end;
$function$;

revoke all on function public.hub_rename_account(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hub_rename_account(uuid, text)
  to authenticated;

comment on function public.hub_rename_account(uuid, text) is
  'Renames an active Hub account through a validated manager-only mutation.';
