begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Provider reads happen outside PostgreSQL, but their authority must still be
-- current at the exact mutation boundary.  This wrapper locks the tenant and
-- integration rows, verifies the broker identity/version observed after the
-- final Asaas reads, and only then delegates to the strict identity repair.
create or replace function public.repair_authoritative_unlinked_student_payment_fenced(
  p_expected_local_payment_id uuid,
  p_expected_student_id uuid,
  p_expected_tenant_id text,
  p_expected_integration_id uuid,
  p_expected_integration_version bigint,
  p_expected_integration_mode text,
  p_authoritative_payment jsonb,
  p_authoritative_subscription jsonb,
  p_authoritative_customer jsonb,
  p_sync_contract_due_day boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text := nullif(
    pg_catalog.btrim(coalesce(p_expected_tenant_id, '')),
    ''
  );
  v_expected_mode text := nullif(
    pg_catalog.btrim(coalesce(p_expected_integration_mode, '')),
    ''
  );
  v_connection private.tenant_integration_connections%rowtype;
  v_result jsonb;
begin
  if p_expected_local_payment_id is null
     or p_expected_student_id is null
     or v_tenant_id is null
     or p_expected_integration_id is null
     or p_expected_integration_version is null
     or p_expected_integration_version <= 0
     or v_expected_mode is null
  then
    raise exception using
      errcode = '22023',
      message = 'authoritative_unlinked_payment_fence_arguments_invalid';
  end if;

  -- Tenant lifecycle and integration rotation cannot cross the mutation.
  perform 1
    from public.tenants as tenant
   where tenant.id = v_tenant_id
   for share;
  if not found or not private.tenant_is_operational(v_tenant_id) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'integration_fence_unavailable'
    );
  end if;

  select connection.*
    into v_connection
    from private.tenant_integration_connections as connection
   where connection.tenant_id = v_tenant_id
     and connection.provider = 'asaas'
   for share;

  if not found
     or v_tenant_id <> 'school-wise-wolf'
     or v_expected_mode <> 'PLATFORM_MANAGED_ROOT'
     or v_connection.id is distinct from p_expected_integration_id
     or v_connection.tenant_id is distinct from v_tenant_id
     or v_connection.provider is distinct from 'asaas'
     or v_connection.mode is distinct from v_expected_mode
     or v_connection.version is distinct from p_expected_integration_version
     or v_connection.status not in ('configured', 'healthy')
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'integration_fence_mismatch'
    );
  end if;

  v_result := public.repair_authoritative_unlinked_student_payment(
    p_expected_local_payment_id,
    p_expected_student_id,
    v_tenant_id,
    p_authoritative_payment,
    p_authoritative_subscription,
    p_authoritative_customer,
    p_sync_contract_due_day,
    p_reason
  );

  return v_result;
end;
$function$;

alter function public.repair_authoritative_unlinked_student_payment_fenced(
  uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,jsonb,boolean,text
) owner to postgres;

revoke all on function public.repair_authoritative_unlinked_student_payment_fenced(
  uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,jsonb,boolean,text
) from public, anon, authenticated;
grant execute on function public.repair_authoritative_unlinked_student_payment_fenced(
  uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,jsonb,boolean,text
) to service_role;

-- The unfenced implementation becomes an internal primitive.  Keeping its
-- body avoids duplicating a large, already-audited identity/ledger repair,
-- while service callers can reach only the atomic wrapper above.
revoke all on function public.repair_authoritative_unlinked_student_payment(
  uuid,uuid,text,jsonb,jsonb,jsonb,boolean,text
) from public, anon, authenticated, service_role;

comment on function public.repair_authoritative_unlinked_student_payment_fenced(
  uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,jsonb,boolean,text
) is
  'Service-only authoritative legacy payment binding with an atomic tenant integration id/version fence at the database mutation boundary.';

comment on function public.repair_authoritative_unlinked_student_payment(
  uuid,uuid,text,jsonb,jsonb,jsonb,boolean,text
) is
  'Internal identity and ledger primitive. External service access is revoked; use the integration-fenced wrapper.';

do $postcheck$
declare
  fenced_oid regprocedure :=
    'public.repair_authoritative_unlinked_student_payment_fenced(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,jsonb,boolean,text)'::regprocedure;
  primitive_oid regprocedure :=
    'public.repair_authoritative_unlinked_student_payment(uuid,uuid,text,jsonb,jsonb,jsonb,boolean,text)'::regprocedure;
  definition text;
begin
  select pg_catalog.pg_get_functiondef(fenced_oid)
    into definition;

  if not exists (
       select 1
         from pg_catalog.pg_proc as procedure
        where procedure.oid = fenced_oid
          and procedure.prosecdef
          and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
     )
     or pg_catalog.strpos(definition, 'for share') = 0
     or pg_catalog.strpos(definition, 'v_connection.version is distinct from') = 0
     or not pg_catalog.has_function_privilege(
       'service_role',
       fenced_oid,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       primitive_oid,
       'EXECUTE'
     )
  then
    raise exception 'authoritative unlinked payment integration fence is incomplete';
  end if;
end
$postcheck$;

commit;
