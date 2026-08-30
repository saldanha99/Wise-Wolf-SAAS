begin;

do $foundation$
begin
  if pg_catalog.to_regprocedure(
       'public.director_pending_counts_unchecked()'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.can_execute_legacy_role_rpc(text[])'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.active_tenant_id(uuid)'
     ) is null
     or pg_catalog.to_regclass(
       'public.management_payment_notification_outbox'
     ) is null
  then
    raise exception 'management payment attention foundation is missing';
  end if;
end;
$foundation$;

-- A provider POST cannot be retried blindly after an ambiguous process crash.
-- Make every such payment notification visible in the director's canonical
-- pending center instead of leaving a service-only attention queue silent.
create or replace function public.director_pending_counts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text;
  v_counts jsonb;
  v_payment_notification_attention integer := 0;
begin
  if not private.can_execute_legacy_role_rpc(
    array['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) then
    return '{}'::jsonb;
  end if;

  v_tenant_id := private.active_tenant_id((select auth.uid()));
  v_counts := coalesce(
    public.director_pending_counts_unchecked(),
    '{}'::jsonb
  );

  if v_tenant_id is not null then
    select pg_catalog.count(*)::integer
      into v_payment_notification_attention
      from public.management_payment_notification_outbox as outbox
     where outbox.tenant_id = v_tenant_id
       and outbox.status in ('SUBMITTING', 'FAILED', 'UNKNOWN');
  end if;

  return v_counts || pg_catalog.jsonb_build_object(
    'avisos_pagamento',
    coalesce(v_payment_notification_attention, 0)
  );
end;
$function$;

alter function public.director_pending_counts() owner to postgres;
alter function public.director_pending_counts() set search_path = '';
revoke all on function public.director_pending_counts()
  from public, anon, authenticated, service_role;
grant execute on function public.director_pending_counts()
  to authenticated, service_role;

do $postcheck$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.director_pending_counts()'::pg_catalog.regprocedure
  );
begin
  if v_definition not like '%management_payment_notification_outbox%'
     or v_definition not like '%avisos_pagamento%'
     or pg_catalog.has_function_privilege(
       'anon', 'public.director_pending_counts()', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated', 'public.director_pending_counts()', 'EXECUTE'
     )
  then
    raise exception 'management payment notification attention is not visible';
  end if;
end;
$postcheck$;

commit;
