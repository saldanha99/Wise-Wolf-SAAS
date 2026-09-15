-- Renewal offers must reach students whose paid term ended.  The general
-- notification helper intentionally rejects suspended/inactive students, so
-- this flow uses a narrower eligibility fence tied to an already-issued,
-- pending renewal offer.  Archived/cancelled/locked records remain blocked.

create or replace function public.student_course_renewal_notification_source(
  p_id uuid,
  p_claim uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  n public.student_course_renewal_notification_outbox%rowtype;
  o private.student_course_renewal_offers%rowtype;
  p public.profiles%rowtype;
  v_phone text;
  v_name text;
begin
  select * into n
    from public.student_course_renewal_notification_outbox
   where id = p_id;
  select * into o
    from private.student_course_renewal_offers
   where id = n.offer_id;
  select * into p
    from public.profiles
   where id = n.student_id
     and tenant_id = n.tenant_id;

  if n.id is null
    or o.id is null
    or p.id is null
    or n.status <> 'CLAIMED'
    or n.claim_token is distinct from p_claim
    or n.submit_attempt_count <> 0
    or n.lease_expires_at < clock_timestamp()
    or o.status <> 'PENDING_SIGNATURE'
    or pg_catalog.upper(pg_catalog.btrim(coalesce(p.role, ''))) <> 'STUDENT'
    or pg_catalog.lower(pg_catalog.btrim(coalesce(p.lifecycle_status, ''))) in (
      'archived', 'cancelled', 'canceled', 'deleted', 'locked'
    )
    or pg_catalog.lower(pg_catalog.btrim(coalesce(p.status, ''))) in (
      'arquivado', 'cancelado', 'trancado'
    )
    or pg_catalog.upper(pg_catalog.btrim(coalesce(p.status_financial, ''))) = 'ARCHIVED'
    or coalesce(p.is_test_account, false)
    or p.test_fixture_key is not null
    or not exists (
      select 1
        from public.tenants as tenant
       where tenant.id = o.tenant_id
         and tenant.whatsapp_enabled
         and private.tenant_is_operational(tenant.id)
    )
  then
    return null;
  end if;

  if p.guardian_id is not null
    or nullif(pg_catalog.btrim(p.guardian_cpf), '') is not null
  then
    v_phone := p.guardian_phone;
    v_name := p.guardian_name;
  else
    v_phone := p.phone;
    v_name := p.full_name;
  end if;

  v_phone := pg_catalog.regexp_replace(coalesce(v_phone, ''), '[^0-9]', '', 'g');
  if pg_catalog.length(v_phone) in (10, 11) then
    v_phone := '55' || v_phone;
  end if;
  if v_phone !~ '^[1-9][0-9]{11,14}$'
    or nullif(pg_catalog.btrim(v_name), '') is null
  then
    return null;
  end if;

  return jsonb_build_object(
    'id', n.id,
    'offer_id', o.id,
    'tenant_id', o.tenant_id,
    'student_id', o.student_id,
    'milestone', n.milestone,
    'token', o.token,
    'recipient_phone', v_phone,
    'recipient_name', pg_catalog.btrim(v_name),
    'student_name', p.full_name,
    'term_months', o.term_months,
    'monthly_fee_cents', o.monthly_fee_cents,
    'classes_per_week', o.classes_per_week,
    'contract_start', o.contract_start,
    'service_end_date', o.service_end_date
  );
end;
$function$;

alter function public.student_course_renewal_notification_source(uuid, uuid)
  owner to postgres;
revoke all on function public.student_course_renewal_notification_source(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.student_course_renewal_notification_source(uuid, uuid)
  to service_role;
